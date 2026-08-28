// Tool definitions for the Spelling Creator MCP server.
//
// This module is transport-agnostic: `registerTools(server, ctx)` attaches every
// tool to a given MCP `server`, whether that server is wired to stdio (local CLI,
// see stdio.js) or to a Streamable-HTTP handler running inside the Worker (remote,
// see worker.js). `ctx` carries the API client and resolved config.
//
// The connected AI assistant writes the lesson content; these tools just give it
// a structured, validated path from "here is the lesson I composed" to a row in
// the hub — reusing the Worker's own validation, author attribution, and ban
// checks (we never set the author; the Worker derives it from the token).

import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { buildDoc, buildLessonFile, QUESTION_TYPES } from "./doc.js";
import { forkLesson, proposeChanges, recordLessonHistory } from "./git.js";
import { applyPatch, findBlock } from "./patch.js";
import { searchWikimediaImages, resolveWikimediaImage } from "./wikimedia.js";
import { LESSON_STANDARDS } from "./standards.js";
import { IMAGE_PICKER_URI, registerViews, rendersViews } from "./views.js";
import { registerCollabTools } from "./collabTools.js";
import {
  formatFindings,
  inputBlocksFromOperations,
  inputBlocksFromSections,
  newFindings,
  validateInput,
  validateLesson,
  validationErrorMessage,
} from "./validate.js";

// One content block, described richly so the model fills the right fields per
// type. buildDoc() does the strict per-type validation and returns clear errors
// the assistant can act on, so this schema stays deliberately lenient.
const blockSchema = z
  .object({
    type: z
      .enum(["text", "spelling", "question", "image"])
      .describe(
        "text = a paragraph of lesson prose (put any words you're teaching the spelling of in ALL CAPS); " +
          "spelling = an explicit list of spelling words; question = a quiz question; " +
          "image = a picture (don't write these by hand — add them with the add_image tool, which uploads the bytes).",
      ),
    text: z
      .string()
      .optional()
      .describe(
        'For type "text": the paragraph. ALL-CAPS words are highlighted as spelling words.',
      ),
    words: z
      .array(z.string())
      .optional()
      .describe(
        'For type "spelling": the words to learn, e.g. ["BECAUSE", "FRIEND"].',
      ),
    questionType: z
      .enum(QUESTION_TYPES)
      .optional()
      .describe(
        'For type "question": number (numeric answer), single (one text answer), multiple (several accepted ' +
          "answers), paraphrase (restate the passage in their own words — no stored answer), open (free " +
          "response), background (needs prior knowledge). Every answer except a background " +
          "one must appear, word for word, in that section's own passage; a background answer must NOT. A single " +
          "(green) answer must also be a HARD FACT with one right answer — being in the passage is not enough. " +
          '"What was the goddess called? → BASTET" is a fact; "What is a cat called when it purrs on a lap? → ' +
          'COMPANION" is interpretation, because pet, friend and lap-cat are all just as fair and COMPANION only ' +
          "looks right because the passage used that word. If a reasonable speller could answer differently and " +
          "still be right, make it an open question or ask for a fact the passage states outright. Of the 7 " +
          "open questions in a section, the first 4 are TIGHT OPENS — open-ended but answerable in ONE WORD from " +
          "the speller's own everyday world, and crucially EASY, with no hard thinking, nothing abstract, and no " +
          'reference to the lesson ("Name a color of a crayon", "Name something found in a hospital"). The last 3 ' +
          'are EXTENDED OPENS, inviting a full sentence ("In your own words, explain…", "…Defend your answer.").',
      ),
    prompt: z
      .string()
      .optional()
      .describe(
        'For type "question": the question text. A "multiple" (orange) prompt quotes the passage sentence ' +
          'holding its list with the list BLANKED OUT — "The blast sent out ______. Name one thing the eruption ' +
          'threw out." — never with the list spelled out, which hands the answer over and is rejected on save. ' +
          "No prompt may name a word another question in the same section expects the speller to retrieve (a green " +
          'answer or an orange option): a green answer of BRITAIN and a later prompt reading "…cats reached ' +
          'Britain around the year ___" gives the green answer away, and is fixed by writing "the British Isles". ' +
          "Naming a topic word whose own question wants a number back is fine.",
      ),
    answer: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Answer for number/single/background questions."),
    answers: z
      .array(z.string())
      .optional()
      .describe(
        'Accepted answers for a "multiple" (orange) question: 2-4 of them, each a SINGLE WORD appearing verbatim ' +
          "in that section's passage. Orange questions are list retrieval, so the answers must be the items of an " +
          'explicit list the passage states — write "The blast sent out red-hot rock, choking gas, and clouds of ' +
          'ash" into the prose, then accept ROCK, GAS, ASH. Answers that never appear together as a list are ' +
          'rejected: "the Pacific Ocean" is one noun phrase, not PACIFIC and OCEAN. Don\'t paraphrase (if the ' +
          'text says "superheated", HOT is not an accepted answer), don\'t ask general knowledge ("name an ocean" ' +
          "is a background question), and don't use long evidence phrases — a speller pointing at a letterboard " +
          "has to spell every word.",
      ),
    steps: z
      .array(z.string())
      .optional()
      .describe(
        'Worked-solution steps for a "number" word problem, one step per element, in order. Always supply these ' +
          "for a word problem — never put the working in the prompt string, and never give a bare answer. Good steps " +
          "show the set-up (not just the arithmetic), flag the common error where one exists, break hard arithmetic " +
          "into manageable pieces, and verify the result where that is cheap. Leave them off the plain " +
          "fill-in-the-blank number question, whose answer is quoted from the passage rather than computed — the " +
          "absence of steps is what marks it as the fill-in-the-blank one.",
      ),
    background: z
      .string()
      .optional()
      .describe('The prior-knowledge context for a "background" question.'),
    image: z
      .object({
        hash: z.string(),
        mime: z.string().optional(),
        ext: z.string().optional(),
      })
      .optional()
      .describe(
        'For type "image": the stored bytes reference produced by add_image. Pass existing ' +
          "image blocks through unchanged when editing a lesson; never invent a hash.",
      ),
    width: z.number().optional().describe('For type "image": pixel width.'),
    height: z.number().optional().describe('For type "image": pixel height.'),
    caption: z
      .string()
      .optional()
      .describe(
        'For type "image": the caption shown under it. Keep the attribution add_image supplies.',
      ),
    align: z
      .enum(["left", "center", "right"])
      .optional()
      .describe('For type "image": horizontal alignment (default center).'),
    size: z
      .string()
      .optional()
      .describe(
        'For type "image": display size key ("small", "medium", "large", or "full"; default full).',
      ),
  })
  // Unknown keys survive the parse so validation can object to them by name.
  // Models reach for `exampleAnswer` on open questions out of habit; stripping it
  // silently would leave the model believing the lesson holds an answer it does
  // not, so it reaches validate.js instead and comes back as a specific error.
  .passthrough()
  .describe("A lesson content block.");

const sectionSchema = z.object({
  name: z.string().optional().describe("Heading for this section."),
  blocks: z
    .array(blockSchema)
    .describe(
      "The blocks in this section, in order. By default a section is: an optional image " +
        "block first (see the image tool note above), then TWO text paragraphs (ALL-CAPS " +
        "words = the harder learning vocabulary, kept separate from the spelling list, and " +
        'TWO explicit "X, Y, and Z" lists planted for the orange questions to retrieve), ' +
        "then a spelling block of 4 words (6-9 letters, thematically related but NOT drawn " +
        "from the passage's ALL-CAPS vocabulary), then 15 question blocks about THIS " +
        "section's content, in this fixed order: 3 single, 1 number (fill-in-the-blank), " +
        "1 number (word problem, with steps), 2 multiple (one per planted list, 2-4 " +
        "single-word answers each), 1 background, 4 open (tight — easy everyday one-word " +
        "answers), 3 open (extended — full-sentence answers). Every section ends " +
        "with its own questions — do not collect them into a separate quiz section at the end.",
    ),
});

const sectionsSchema = z
  .array(sectionSchema)
  .min(1)
  .describe(
    "The lesson's sections, in order. Default to SIX sections unless the user asks for " +
      "more or fewer. Each section is self-contained: ~2 paragraphs of prose, 4 spelling " +
      "words, and 15 questions on that section's own content (see blocks below).",
  );

// One patch operation (for patch_lesson). Kept lenient — applyPatch (patch.js)
// does the strict per-op validation and returns errors naming the operation.
const operationSchema = z
  .object({
    op: z
      .enum([
        "set_title",
        "set_section_name",
        "add_section",
        "remove_section",
        "move_section",
        "add_block",
        "replace_block",
        "remove_block",
        "move_block",
      ])
      .describe("Which edit to make."),
    title: z
      .string()
      .optional()
      .describe("For set_title: the new lesson title."),
    sectionId: z
      .string()
      .optional()
      .describe(
        "Target section id (from get_lesson). Required by *_section ops and add_block.",
      ),
    blockId: z
      .string()
      .optional()
      .describe(
        "Target block id (from get_lesson). Required by replace_block/remove_block/move_block.",
      ),
    name: z
      .string()
      .optional()
      .describe("For set_section_name / add_section: the section heading."),
    index: z
      .number()
      .int()
      .optional()
      .describe(
        "0-based target position; omit to append. Used by add_section/move_section/add_block/move_block.",
      ),
    block: blockSchema
      .optional()
      .describe(
        "A single block (same shape as create_lesson) for add_block / replace_block.",
      ),
    blocks: z
      .array(blockSchema)
      .optional()
      .describe("Blocks for a new add_section."),
  })
  .describe("One edit operation, addressing sections/blocks by their id.");

// What search_images returns, declared so the same payload can travel as
// `structuredContent` for the image picker view to render (see views.js).
// Deliberately loose: every field but the `ref` is whatever Commons happened to
// have on the file, and a candidate missing an author is still a candidate.
const imageSearchOutputSchema = {
  query: z.string(),
  count: z.number(),
  images: z.array(
    z
      .object({
        ref: z.string(),
        description: z.string().optional(),
        caption: z.string().optional(),
        author: z.string().optional(),
        license: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        mime: z.string().optional(),
        previewURL: z.string().optional(),
        source: z.string().optional(),
      })
      .passthrough(),
  ),
  lessonId: z.string().optional(),
  placement: z
    .object({
      sectionIndex: z.number().optional(),
      index: z.number().optional(),
    })
    .optional(),
  note: z.string().optional(),
};

// The two halves of what search_images tells the model, kept apart because they
// ask for opposite behaviour and only one of them can be true per client.
//
// Without a picker on screen the assistant is the only one who can choose, so it
// should — a list of Commons files is no use to a user who'd have to type a
// filename back.
const PICK_ONE_YOURSELF =
  "Choose the best `ref` and call add_image to insert it. The `caption` carries the licence attribution " +
  "Commons requires — keep it on the image.";

// With one, choosing is the user's, and an assistant that keeps going takes it
// away from them: it picks from descriptions, adds an image nobody asked for,
// and leaves a picker on screen that the lesson has already moved past. Said as
// bluntly as it is, because "the user may pick" reads as permission to do it
// first, and this is the exact failure the picker was built to prevent.
const PICKER_IS_THE_USERS =
  "These candidates are on screen in the image picker and the USER is choosing one. STOP HERE: do not call " +
  "add_image, and do not pick for them. They can see the pictures; you cannot, which is the whole point of the " +
  "picker. End your turn now — a short line inviting them to pick is all that's wanted, and choosing on their " +
  "behalf wastes the search. When they click you will be told which file it was: either that it is already in " +
  "the lesson (don't add it again) or which `ref` to use with add_image.";

// Render a value as a text content result (the MCP content shape).
function text(value) {
  const body =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: body }] };
}

// A safe-ish .json filename derived from the lesson title (mirrors the web
// exporter's safeFileName). Falls back to "lesson" when nothing usable remains.
function lessonFileName(title) {
  const base = (title || "lesson")
    .trim()
    .replace(/[^a-z0-9\-_ ]/gi, "")
    .replace(/\s+/g, "-");
  return `${base || "lesson"}.json`;
}

function errorResult(err) {
  return {
    content: [{ type: "text", text: `Error: ${err.message || String(err)}` }],
    isError: true,
  };
}

// The `skipValidation` input, shared by every tool that writes a lesson.
const skipValidationSchema = z
  .boolean()
  .optional()
  .describe(
    "Save even if the lesson breaks the authoring standard (see this tool's standards text). Only for when " +
      "the user deliberately wants something the standard forbids — a 3-section lesson, a different question " +
      "order. Never use it to get past a defect you could fix; the rejection message says exactly what to change. " +
      "On a client that can put a question to the user, setting this asks them to approve the override and lists " +
      "what would be waived, so setting it on a hunch wastes their time and mine.",
  );

// The `summary` input, shared by the tools that edit an existing lesson.
//
// Without one, recordLessonHistory names the version after what changed
// mechanically ("Edit 2 text blocks, add 15 question blocks"), which is accurate
// and tells the user nothing about why. That is fine for a one-off tweak and
// poor for a lesson built up in passes, where the History tab ends up a column
// of near-identical op counts the user has to open one by one to tell apart.
//
// The assistant is the only party that knows what the pass was for, so it says.
// The full op list still rides along in the commit body either way — this
// replaces the subject line, not the record.
const summarySchema = z
  .string()
  .optional()
  .describe(
    "One short line naming what this edit was for, shown as the version's title in the lesson's History tab " +
      '("Add section 3: volcanic ash", "Rewrite the orange questions"). Write it for the user reading the tab ' +
      "later, not as a restatement of the operations — those are recorded underneath it anyway. Clamped to 72 " +
      "characters. Omit it and the version is named after what mechanically changed.",
  );

// Findings carry an internal level and dedupe key; the assistant only needs to
// know what is wrong and where.
function toWireWarnings(warnings) {
  return warnings.map(({ code, section, message }) =>
    section == null ? { code, message } : { code, section, message },
  );
}

/**
 * The standard's verdict on a document, as data: what would be rejected
 * (`failures`) and what would merely be reported (`flags`).
 *
 * Split out of checkStandard so validate_lesson can report the same findings
 * that a write would act on. Keeping one function behind both is the point —
 * "check it here, then write it" is only worth anything if the two agree, and
 * two copies of this would drift apart the first time a rule changed.
 *
 * `baselineDoc` (patch_lesson, and validate_lesson previewing a patch) holds the
 * lesson as it was before the edit, and limits both lists to the ones the edit
 * actually introduced. Without it, a one-line tweak to a lesson written in the
 * web editor — or written before these rules existed — would be blocked by
 * defects the caller never touched and may not be able to fix.
 *
 * @param {{ doc: any, rawBlocks?: any[], baselineDoc?: any }} args
 * @returns {{ failures: import('./validate.js').Finding[], flags: import('./validate.js').Finding[] }}
 */
function standardFindings({ doc, rawBlocks = [], baselineDoc = null }) {
  const { errors, warnings } = validateLesson(doc);
  let failures = [...validateInput(rawBlocks), ...errors];
  let flags = warnings;

  if (baselineDoc) {
    const before = validateLesson(baselineDoc);
    failures = newFindings(before.errors, failures);
    flags = newFindings(before.warnings, flags);
  }

  return { failures, flags };
}

/**
 * How validate_lesson reports one check.
 *
 * `ok` answers the question actually being asked — would a write of this be
 * accepted? — before either list, so a model that reads no further still gets it
 * right. The lists themselves carry the same self-correcting messages a rejected
 * write would have returned.
 *
 * @param {{ checked: string, failures: any[], flags: any[], preexisting?: object }} args
 */
function verdict({ checked, failures, flags, preexisting }) {
  const ok = failures.length === 0;
  return {
    ok,
    checked,
    errors: toWireWarnings(failures),
    warnings: toWireWarnings(flags),
    ...(preexisting ? { preexisting } : {}),
    note: ok
      ? flags.length
        ? "No errors — a write of this would be accepted. The warnings would ride along with it: worth fixing, " +
          "but they don't block."
        : "Clean — a write of this would be accepted with nothing to report."
      : `A write of this would be REJECTED. Fix the ${failures.length} error${failures.length === 1 ? "" : "s"} ` +
        "above and check again. Nothing has been saved either way.",
  };
}

/**
 * Attach all tools to an MCP server.
 *
 * `ctx.live` says whether this transport can hold state between tool calls.
 * Stdio can — it is one process per client — so it gets the collaboration
 * session tools. The Worker builds a fresh server per request and has nowhere to
 * keep a WebSocket, so it doesn't, and they are left unregistered rather than
 * advertised and then failing at the one moment somebody needs them.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ api: ReturnType<import('./api.js').createApi>, config: ReturnType<import('./config.js').loadConfig>, auth?: any, live?: boolean }} ctx
 */
export function registerTools(server, ctx) {
  const { api, config, auth, live = false } = ctx;

  // The `ui://` resources behind the tools that have a view. Registered
  // unconditionally: a host that doesn't do MCP Apps simply never reads them.
  registerViews(server, config);

  const hubUrl = (id) => `${config.apiUrl}/hub/${id}`;
  const proposalUrl = (lessonId, pullId) =>
    `${hubUrl(lessonId)}/proposals/${pullId}`;

  // Which MCP client is connected, by its own account of itself — recorded on a
  // commit and on a proposal so the user can see the changes came from an
  // assistant rather than from them (see assistantNote in git.js). Only known
  // once the client has initialised, and not every client sends it, so this is
  // best-effort.
  const clientName = () => {
    try {
      return server.server.getClientVersion()?.name || "";
    } catch {
      return "";
    }
  };

  // Wrap a handler so thrown errors become a clean isError result the assistant
  // can read and recover from, rather than a transport-level failure.
  const tool = (handler) => async (args) => {
    try {
      return await handler(args || {});
    } catch (err) {
      return errorResult(err);
    }
  };

  /**
   * Put a yes/no question to the USER, mid-tool-call, over the same connection.
   *
   * This exists for the handful of decisions that are the user's and have until
   * now been made by the model on their behalf: deleting a lesson for good, and
   * overriding the authoring standard. Both are cases where the tool
   * descriptions ask the model to check with the user first — which is prose it
   * may or may not act on, and neither the server nor the user can tell whether
   * it did. Asking directly is the difference between a rule and a request.
   *
   * The same reasoning as the image picker (see views.js): where a choice is
   * genuinely the user's, an assistant that makes it takes it away from them.
   *
   * Returns true if they said yes, false if they said no or dismissed the
   * prompt, and **null if they were never asked** — the client doesn't do
   * elicitation, or the ask itself failed. Null is not consent and it is not
   * refusal; it means this connection has no way to reach the user, and the
   * caller decides what to do about it. Elicitation is optional in the MCP spec
   * and most clients still don't implement it, so null is the common case and
   * every caller must leave those clients working exactly as they did.
   *
   * @param {string} message  The question, as the user will read it.
   * @param {string} title    The affirmative answer's label.
   * @returns {Promise<boolean|null>}
   */
  const askUser = async (message, title) => {
    let capable = false;
    try {
      capable = Boolean(server.server.getClientCapabilities()?.elicitation);
    } catch {
      return null;
    }
    if (!capable) return null;

    try {
      const res = await server.server.elicitInput({
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              title,
              description: "Leave this unchecked to stop.",
            },
          },
          required: ["confirm"],
        },
      });
      // "decline" and "cancel" are both a no. Only an explicit accept carrying
      // an explicit true is a yes — an accept with the box unticked is the user
      // saying no through the form rather than through the buttons.
      if (res.action !== "accept") return false;
      return res.content?.confirm === true;
    } catch {
      // The client said it could ask and then couldn't. Treated as "not asked"
      // rather than as a refusal, so a flaky client doesn't make a tool
      // impossible to use — the caller falls back to how it behaved before.
      return null;
    }
  };

  /**
   * Run the authoring standard over a lesson about to be written.
   *
   * Throws when it fails, which the `tool()` wrapper turns into a readable
   * isError result — so a rejected lesson is never saved, and the assistant gets
   * a message naming every defect and its fix. Returns the warnings to ride
   * along with a successful write.
   *
   * `skipValidation` is the interesting path. It suppresses the check entirely,
   * and it is meant for a user who deliberately wants something the standard
   * forbids — but the model is the one that sets it, and nothing ever confirmed
   * the user had asked for any such thing. So the findings are computed even
   * when it is set, and where a client can reach the user, the override becomes
   * a question put to them, naming what would be waived. Where a client cannot,
   * the flag behaves exactly as it always has.
   *
   * @param {{ doc: any, rawBlocks?: any[], skipValidation?: boolean, baselineDoc?: any }} args
   * @returns {Promise<Array<{ code: string, section?: number, message: string }>>}
   */
  const checkStandard = async ({
    doc,
    rawBlocks = [],
    skipValidation = false,
    baselineDoc = null,
  }) => {
    const { failures, flags } = standardFindings({
      doc,
      rawBlocks,
      baselineDoc,
    });

    if (!skipValidation) {
      if (failures.length) throw new Error(validationErrorMessage(failures));
      return toWireWarnings(flags);
    }

    if (failures.length) {
      const allowed = await askUser(
        `The assistant is about to save a lesson that breaks the authoring standard in ` +
          `${failures.length} way${failures.length === 1 ? "" : "s"}, by overriding the check:\n\n` +
          `${formatFindings(failures, 5)}\n\n` +
          "Save it as it is?",
        "Save it anyway",
      );
      if (allowed === false) {
        throw new Error(
          "The user was asked whether to save this lesson despite breaking the authoring standard, and said no. " +
            `Nothing was saved. Fix the ${failures.length} problem${failures.length === 1 ? "" : "s"} instead:\n\n` +
            `${formatFindings(failures)}\n\n` +
            "Do not call the tool again with skipValidation until the user asks you to.",
        );
      }
    }

    // Skipping the check skips the warnings with it: nothing was reported.
    return [];
  };

  /**
   * Commit a saved document into the lesson's version history, and say what
   * happened in terms the assistant can pass on.
   *
   * Every tool that writes a document calls this straight after the write. The
   * hub's row and the hub's repository are separate stores (see git.js), so a
   * save that didn't come through here would leave the lesson's History tab
   * denying the edit ever happened — the one place the user looks to see what an
   * assistant did to their lesson, and the only way back if they don't like it.
   *
   * It never throws: the document is saved either way, and a history that didn't
   * move is worth reporting but not worth failing a completed write over.
   */
  const recordHistory = async ({ lessonId, doc, previousDoc, summary }) => {
    const result = await recordLessonHistory(api, {
      lessonId,
      doc,
      previousDoc,
      summary,
      client: clientName(),
    });
    if (result.recorded) {
      return {
        recorded: true,
        commit: result.commit,
        summary: result.summary,
        ...(result.seeded
          ? {
              note: "This lesson had no version history before; one was started from its previous content.",
            }
          : {}),
      };
    }
    return {
      recorded: false,
      note:
        result.reason === "unchanged"
          ? "Nothing the version history stores actually changed, so no new version was recorded."
          : `The lesson is saved, but this change could not be added to its version history, so it won't ` +
            `appear in the History tab and can't be reverted from there. (${result.reason})`,
    };
  };

  /**
   * The lesson as it stands, for the tools that need a before-picture to hand to
   * recordHistory but can do their job without one. Tolerant on purpose: a read
   * that fails must not stop a write the user asked for — it only costs the
   * catch-up commit, which is a tidiness in the history rather than the edit.
   *
   * Also says whether the lesson is already public, which decides whether
   * `published: true` is a change worth asking the user about.
   */
  const currentLesson = async (id) => {
    try {
      return (await api.getLesson(id)) || null;
    } catch {
      return null;
    }
  };

  /**
   * Ask before a lesson becomes publicly readable under the user's name.
   *
   * Publishing is outward-facing in a way nothing else here is: the lesson is
   * listed on the hub, attributed to them, and anyone can read and fork it. That
   * makes it their call, the same as deleting — see askUser.
   *
   * Unlike deleting, it is reversible, and unlike skipValidation it is often
   * exactly what was asked for. So this only asks on the way OUT (nothing
   * confirms unpublishing) and only when public is a change from where the
   * lesson already was. A "no" never costs the work: every caller falls back to
   * saving the lesson as a private draft rather than failing the write.
   *
   * @param {string} named  The lesson, as the user should see it named.
   * @returns {Promise<boolean>} Whether to go ahead and publish.
   */
  const mayPublish = async (named) => {
    const answer = await askUser(
      `Publish the lesson ${named} to the public Spelling Creator hub? It will be listed publicly under your ` +
        "name, and anyone will be able to read, copy and fork it. You can unpublish it again at any time.",
      "Publish it",
    );
    // Only an actual refusal stops it: a client that can't ask must publish
    // exactly as it did before.
    return answer !== false;
  };

  /**
   * What `published` an edit should actually write, having asked the user first
   * if the edit would take a private lesson public.
   *
   * The editing tools carry `published` as a rider on a content change, so a
   * refusal must not lose the edit: the content is written either way and only
   * the visibility is held back. When that happens the result says so — the
   * assistant asked for something it didn't get, and has to know it was the user
   * who overruled it rather than assume the field was ignored.
   *
   * @param {{ published: boolean|undefined, wasPublished: boolean, named: string }} args
   * @returns {Promise<{ published: boolean|undefined, note?: string }>}
   */
  const resolveVisibility = async ({ published, wasPublished, named }) => {
    // Omitted, unpublishing, or already public — nothing is becoming visible
    // that wasn't, so there is nothing to ask about.
    if (published !== true || wasPublished) return { published };
    if (await mayPublish(named)) return { published: true };
    return {
      published: false,
      note:
        "The content changes were saved, but the user was asked about publishing and said no, so the lesson is " +
        "still a PRIVATE DRAFT. Don't try to publish it again unless they ask you to.",
    };
  };

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Confirm the configured Supabase session is valid and show the publishing identity (display name). " +
        "Publishing requires a display name — check this first if create_lesson fails with a permission error.",
      inputSchema: {},
    },
    tool(async () => {
      const me = await api.whoami();
      if (!me.displayName) {
        return text(
          `Signed in (user ${me.id}) but no display name is set, so publishing will be rejected. ` +
            "Set a display name once in the web app (spellingcreator.org), then retry.",
        );
      }
      return text({ id: me.id, displayName: me.displayName });
    }),
  );

  server.registerTool(
    "validate_lesson",
    {
      title: "Check a lesson against the standard",
      description:
        "Check lesson content against the authoring standard WITHOUT saving anything. The same checks and the " +
        "same messages the writing tools use, so what passes here passes there.\n\n" +
        "Use it AS YOU COMPOSE rather than writing a whole lesson blind. The standard is strict — grounding, " +
        "spelling-word length, answer uniqueness — and create_lesson rejects a lesson outright when any of it " +
        "fails, so a six-section lesson written in one shot rarely lands first time. Build a section, check it, " +
        "fix what the messages name, then go on to the next: no lesson is created, no document overwritten, and " +
        "no version added to anyone's History tab. Checking `sections` is entirely local — nothing is fetched " +
        "either — so do that as often as you like; checking by `id` reads the lesson from the hub first, which " +
        "writes nothing but is still a request, so don't poll with it.\n\n" +
        "Two ways to call it:\n" +
        "• `sections` (with an optional `title`) — content you are composing, in create_lesson's shape. It need " +
        "not be a whole lesson; a single section is a perfectly good thing to check.\n" +
        "• `id` — a lesson that already exists on the hub. Add `operations` (patch_lesson's shape) to see what " +
        "that patch WOULD produce, without applying it.\n\n" +
        "`errors` are what would be rejected; `warnings` are what would be reported alongside a successful write. " +
        "When you pass `id`, defects already in the stored lesson are counted under `preexisting` instead of being " +
        "held against you — exactly as patch_lesson treats them.\n\n" +
        LESSON_STANDARDS,
      inputSchema: {
        title: z
          .string()
          .optional()
          .describe(
            "The draft's title. Optional — the standard says nothing about titles; it only makes the result " +
              "easier to read.",
          ),
        sections: sectionsSchema
          .optional()
          .describe(
            "Content you are composing, in create_lesson's shape — a whole lesson, or the one section you just " +
              "wrote. Omit when checking an existing lesson by `id`.",
          ),
        id: z
          .string()
          .optional()
          .describe(
            "The id of a lesson on the hub to check as it stands. Omit when checking `sections` you are composing.",
          ),
        operations: z
          .array(operationSchema)
          .min(1)
          .optional()
          .describe(
            "With `id`: the patch_lesson operations to try. They are applied to a copy in memory and the result " +
              "is checked; the stored lesson is not touched.",
          ),
      },
    },
    tool(async ({ title, sections, id, operations }) => {
      if (sections && id) {
        throw new Error(
          "Pass either `sections` (content you are composing) or `id` (a lesson on the hub), not both.",
        );
      }
      if (operations && !id) {
        throw new Error(
          "`operations` previews a patch to a lesson that already exists, so it needs that lesson's `id`. " +
            "To check content you are composing, pass `sections` on its own.",
        );
      }
      if (!sections && !id) {
        throw new Error(
          "Nothing to check. Pass `sections` to check content you are composing, or `id` to check a lesson on the hub.",
        );
      }

      // Composing: build exactly what create_lesson/update_lesson would build,
      // and check exactly what they would check.
      if (sections) {
        const doc = buildDoc({ title, sections });
        const { failures, flags } = standardFindings({
          doc,
          rawBlocks: inputBlocksFromSections(sections),
        });
        const count = doc.sections.length;
        return text(
          verdict({
            checked: `draft content — ${count} section${count === 1 ? "" : "s"}, nothing saved`,
            failures,
            flags,
          }),
        );
      }

      // An existing lesson, optionally with a patch applied to the fetched copy.
      // Read-only either way: applyPatch works in memory and no write follows it.
      const current = await api.getLesson(id);
      if (!operations) {
        const { failures, flags } = standardFindings({ doc: current.doc });
        return text(
          verdict({ checked: `lesson ${id} as stored`, failures, flags }),
        );
      }

      const doc = applyPatch(current.doc, operations);
      const { failures, flags } = standardFindings({
        doc,
        rawBlocks: inputBlocksFromOperations(operations),
        baselineDoc: current.doc,
      });
      const before = validateLesson(current.doc);
      return text(
        verdict({
          checked:
            `lesson ${id} with ${operations.length} operation${operations.length === 1 ? "" : "s"} applied in ` +
            "memory — the stored lesson is unchanged",
          failures,
          flags,
          preexisting: {
            errors: before.errors.length,
            warnings: before.warnings.length,
            note:
              "Defects already in the stored lesson. They are not counted against this patch, and patch_lesson " +
              "would not block on them either.",
          },
        }),
      );
    }),
  );

  server.registerTool(
    "create_lesson",
    {
      title: "Create a lesson",
      description:
        "Create a new spelling lesson on the hub. You compose the content; this builds the lesson document " +
        "(generating all ids) and saves it. Defaults to a private DRAFT — set published: true to share it on the " +
        "public hub. Returns the new lesson id and its hub URL.\n\n" +
        "A lesson is sections of blocks. Block types: text (prose — put words being taught in ALL CAPS), " +
        "spelling (an explicit word list), question (number/single/multiple/open/background), and image.\n\n" +
        "DEFAULT STRUCTURE (unless the user asks otherwise): 6 sections; each section is [image?] + 2 text " +
        "paragraphs + 4 spelling words + 15 questions, and ENDS with those question blocks about that section. " +
        "Put questions after EVERY section — do NOT gather them into a single quiz section at the end. Honour the " +
        "user when they request a different length, more/fewer questions, or a specific shape.\n\n" +
        "Lessons are written for spellers who answer by pointing to letters on a letterboard, so answers must be " +
        "short and unambiguous, and every answer except the background one must be findable in that section's own " +
        "passage. Writes are validated against the standard below: grounding, spelling-word and uniqueness failures " +
        "are REJECTED with a message naming the section, the offending value and the fix — read it and resubmit.\n\n" +
        "Don't compose all six sections blind and hope. Check your work with validate_lesson as you go — it runs " +
        "these same checks without saving anything — and call this once it comes back clean. For a long lesson you " +
        "can also create the first section or two here and add the rest with patch_lesson, a pass at a time; see " +
        "that tool.\n\n" +
        LESSON_STANDARDS,
      inputSchema: {
        title: z.string().describe("The lesson title / topic."),
        sections: sectionsSchema,
        published: z
          .boolean()
          .optional()
          .describe(
            "true = publish to the public hub now; false (default) = save as a private draft.",
          ),
        skipValidation: skipValidationSchema,
      },
    },
    tool(async ({ title, sections, published = false, skipValidation }) => {
      const doc = buildDoc({ title, sections });
      // Throws (and saves nothing) when the lesson breaks the standard.
      const warnings = await checkStandard({
        doc,
        rawBlocks: inputBlocksFromSections(sections),
        skipValidation,
      });
      // Asked before the write, so a "no" saves a draft rather than publishing
      // and retracting.
      const publish = published ? await mayPublish(`"${doc.title}"`) : false;
      const lesson = await api.createLesson({
        title: doc.title,
        doc,
        published: publish,
      });
      const result = {
        ...lesson,
        url: hubUrl(lesson.id),
        // A new lesson has nothing before it, so the first commit is the lesson
        // arriving — named for what it is rather than as ninety separate adds.
        history: await recordHistory({
          lessonId: lesson.id,
          doc,
          summary: `Create "${doc.title}"`,
        }),
        note: publish
          ? "Published to the public hub."
          : published
            ? "The user was asked about publishing and said no, so the lesson was saved as a PRIVATE DRAFT instead " +
              "— nothing else about it changed, and no work was lost. Don't publish it unless they ask you to."
            : "Saved as a private draft. Call set_lesson_published to share it.",
      };
      // Soft warnings: the lesson saved fine, but flag shape issues (e.g. a
      // section with no question) so the assistant can offer to fix them.
      if (warnings.length) result.warnings = warnings;
      return text(result);
    }),
  );

  server.registerTool(
    "create_lesson_file",
    {
      title: "Create a lesson file (offline)",
      description:
        "Build a spelling lesson entirely offline — no account, network, or sign-in needed. You compose the content " +
        "(same structure as create_lesson); this validates it, generates all ids, and returns a self-contained lesson " +
        "FILE. Save the returned `lessonFile` object verbatim as a `.json` file, then open the Spelling Creator editor " +
        "(spellingcreator.org) and load it with the “Import JSON” button (next to “Import Word " +
        "document”). Use this when you can't (or don't want to) publish to the hub; use create_lesson when you " +
        "want it saved to the cloud directly.\n\n" +
        "A lesson is sections of blocks. Block types: text (prose — put words being taught in ALL CAPS), spelling (an " +
        "explicit word list), question (number/single/multiple/open/background), and image. DEFAULT STRUCTURE " +
        "(unless asked otherwise): 6 sections; each is [image?] + 2 text paragraphs + 4 spelling words + 15 " +
        "questions, and ENDS with those question blocks about that section. Same full authoring standard as " +
        "create_lesson (question order/counts, spelling-word rules, math/steps conventions, image placement) — " +
        "see that tool's description. The same validation applies too: a lesson that breaks the standard is " +
        "rejected with a message naming each defect and its fix, and no file is returned.",
      inputSchema: {
        title: z.string().describe("The lesson title / topic."),
        sections: sectionsSchema,
        skipValidation: skipValidationSchema,
      },
    },
    tool(async ({ title, sections, skipValidation }) => {
      const doc = buildDoc({ title, sections });
      const warnings = await checkStandard({
        doc,
        rawBlocks: inputBlocksFromSections(sections),
        skipValidation,
      });
      const result = {
        lessonFile: buildLessonFile(doc),
        filename: lessonFileName(doc.title),
        note:
          "Save the `lessonFile` object as a .json file (suggested name in `filename`), then import it in the " +
          'Spelling Creator editor via the "Import JSON" button. This works fully offline — no account needed.',
      };
      if (warnings.length) result.warnings = warnings;
      return text(result);
    }),
  );

  server.registerTool(
    "update_lesson",
    {
      title: "Update a lesson",
      description:
        "Replace the title and content of a lesson you authored. This overwrites the whole document, so pass the " +
        "complete set of sections you want the lesson to have (use get_lesson first if you need the current content). " +
        "Optionally flip published to move between draft and public.\n\n" +
        "The result is checked against the same authoring standard as create_lesson (see that tool's description) " +
        "and rejected if it breaks it. Because this replaces everything, you own every defect in the result — " +
        "including ones already in the lesson you fetched. Prefer patch_lesson for a small edit: it only holds you " +
        "to the problems your edit introduces.\n\n" +
        "The edit is committed to the lesson's version history, so the user can read the diff and revert it from " +
        "the lesson's History tab. `history` in the result says what was recorded.",
      inputSchema: {
        id: z.string().describe("The id of the lesson to update."),
        title: z.string().describe("The (possibly unchanged) lesson title."),
        sections: sectionsSchema,
        published: z
          .boolean()
          .optional()
          .describe(
            "Omit to leave visibility unchanged; true/false to publish or unpublish.",
          ),
        summary: summarySchema,
        skipValidation: skipValidationSchema,
      },
    },
    tool(
      async ({ id, title, sections, published, summary, skipValidation }) => {
        const doc = buildDoc({ title, sections });
        // A full replace, so the caller owns every defect in the result.
        const warnings = await checkStandard({
          doc,
          rawBlocks: inputBlocksFromSections(sections),
          skipValidation,
        });
        // Read before writing, so the version history has a before-picture to
        // diff against and so we know whether `published: true` is a change.
        // Only the write below decides whether the call succeeds.
        const current = await currentLesson(id);
        const visibility = await resolveVisibility({
          published,
          wasPublished: current?.published === true,
          named: `"${doc.title}"`,
        });
        const lesson = await api.updateLesson(id, {
          title: doc.title,
          doc,
          published: visibility.published,
        });
        const result = {
          ...lesson,
          url: hubUrl(lesson.id),
          history: await recordHistory({
            lessonId: id,
            doc,
            previousDoc: current?.doc || null,
            summary,
          }),
        };
        if (visibility.note) result.note = visibility.note;
        if (warnings.length) result.warnings = warnings;
        return text(result);
      },
    ),
  );

  server.registerTool(
    "patch_lesson",
    {
      title: "Patch a lesson",
      description:
        "Edit a lesson you authored with a small list of operations, instead of resending the whole document. " +
        "Prefer this over update_lesson for anything short of a full rewrite. Call get_lesson first to read the " +
        "current sections/blocks and their ids; operations address them by id. The server fetches the lesson, " +
        "applies the operations in order, then saves the result.\n\n" +
        "TWO USES. The obvious one is a tweak — a typo, a wrong answer, a reworded prompt. The other is BUILDING A " +
        "LESSON UP IN PASSES: create_lesson with the first section or two, then add_section the rest one pass at a " +
        "time. A six-section lesson is a lot to get right in a single call, and every pass here is checked, " +
        "reversible and named, where one big create_lesson is all-or-nothing. Check each pass with validate_lesson " +
        "before you send it and you will rarely be rejected. (If you would rather compose the whole document first, " +
        "that is fine too — validate_lesson as you go, then one create_lesson at the end. What to avoid is writing " +
        "six sections blind and hoping.)\n\n" +
        "Operations (each is { op, ... }):\n" +
        "• set_title { title }\n" +
        "• set_section_name { sectionId, name }\n" +
        "• add_section { name?, blocks?, index? }   — append, or insert at index\n" +
        "• remove_section { sectionId }\n" +
        "• move_section { sectionId, index }\n" +
        "• add_block { sectionId, block, index? }\n" +
        "• replace_block { blockId, block }         — keeps the block's id\n" +
        "• remove_block { blockId }\n" +
        "• move_block { blockId, sectionId?, index? }\n\n" +
        "`block`/`blocks` use the same shape as create_lesson. `index` is 0-based; omit it to append.\n\n" +
        "The patched lesson is checked against the authoring standard (see create_lesson), but only the defects " +
        "your edit introduces are held against you — pre-existing problems in a lesson written elsewhere won't " +
        "block a small tweak.\n\n" +
        "Each patch is committed to the lesson's version history as its own version, so the user can read the diff " +
        "and revert it from the lesson's History tab. `history` in the result says what was recorded. Pass a " +
        "`summary` so each version says what the pass was for — building a lesson in passes otherwise leaves the " +
        "user a column of near-identical op counts to tell apart.",
      inputSchema: {
        id: z.string().describe("The id of the lesson to patch."),
        operations: z
          .array(operationSchema)
          .min(1)
          .describe("The edit operations, applied in order."),
        published: z
          .boolean()
          .optional()
          .describe(
            "Omit to leave visibility unchanged; true/false to publish or unpublish.",
          ),
        summary: summarySchema,
        skipValidation: skipValidationSchema,
      },
    },
    tool(async ({ id, operations, published, summary, skipValidation }) => {
      // Fetch current content, apply the diff in memory, then save (the Worker
      // only offers a full-replace PUT — see api.updateLesson).
      const current = await api.getLesson(id);
      const doc = applyPatch(current.doc, operations);
      // Only the defects this patch introduced: a small edit to a lesson written
      // elsewhere shouldn't be blocked by what was already there.
      const warnings = await checkStandard({
        doc,
        rawBlocks: inputBlocksFromOperations(operations),
        skipValidation,
        baselineDoc: current.doc,
      });
      const visibility = await resolveVisibility({
        published,
        wasPublished: current.published === true,
        named: `"${doc.title || current.title}"`,
      });
      const lesson = await api.updateLesson(id, {
        title: doc.title || current.title,
        doc,
        published: visibility.published,
      });
      const result = {
        ...lesson,
        url: hubUrl(lesson.id),
        history: await recordHistory({
          lessonId: id,
          doc,
          previousDoc: current.doc,
          summary,
        }),
      };
      if (visibility.note) result.note = visibility.note;
      if (warnings.length) result.warnings = warnings;
      return text(result);
    }),
  );

  server.registerTool(
    "fork_lesson",
    {
      title: "Fork a lesson",
      description:
        "Copy a lesson into a new private draft of your own, keeping its version history and a link back to the " +
        "original. This is the first step of the review flow:\n\n" +
        "  1. fork_lesson(lessonId)      -> a draft fork you own\n" +
        "  2. patch_lesson(fork.id, ...) -> edit THE FORK, not the original\n" +
        "  3. propose_changes(...)       -> open a proposal for a human to read and merge\n\n" +
        "USE THIS INSTEAD OF EDITING DIRECTLY when either applies:\n" +
        "• The lesson was written by someone else. You cannot save over it at all — a proposal is the only route.\n" +
        "• The user wants to look over your changes before they go live. Editing their lesson with patch_lesson " +
        "  overwrites it immediately — recorded in the lesson's history, so it can be reverted afterwards, but " +
        "  nobody got to decide first; forking leaves the lesson untouched until they merge, and they can decline.\n\n" +
        "Prefer editing directly (patch_lesson) for a small correction to the user's own lesson that they have " +
        "asked for outright — a typo, a wrong answer — where a review step is just friction.\n\n" +
        "Forks count against your private-draft limit; delete_lesson the fork once its proposal is merged or " +
        "declined. Images are shared with the original rather than copied, so forking is cheap.",
      inputSchema: {
        lessonId: z.string().describe("The id of the lesson to fork."),
        title: z
          .string()
          .optional()
          .describe(
            "Title for the fork. Defaults to the original's — usually right, since a proposal is a change to " +
              "that lesson rather than a new one.",
          ),
      },
    },
    tool(async ({ lessonId, title }) => {
      const { lesson, head, clonedHistory } = await forkLesson(api, {
        lessonId,
        title,
      });
      return text({
        ...lesson,
        url: hubUrl(lesson.id),
        head,
        note:
          `Forked into a private draft (${lesson.id}). Edit THIS id, not ${lessonId}, then call propose_changes ` +
          `with forkLessonId: "${lesson.id}".` +
          (clonedHistory
            ? ""
            : " The original has no stored version history, so this fork shares no common ancestor with it — a " +
              "reviewer will see the whole document as the change rather than a tidy diff."),
      });
    }),
  );

  server.registerTool(
    "propose_changes",
    {
      title: "Propose a fork's changes",
      description:
        "Offer the changes you made to a fork back to the lesson it came from, as a proposal a human reviews. " +
        "Call this after fork_lesson and after editing the fork.\n\n" +
        "Nothing is written to the target lesson: the proposal is a snapshot of your fork, and the lesson's author " +
        "(or a trusted collaborator) merges it from the web app, block by block, or declines it. Tell the user the " +
        "returned `url` — that is the page where they read the diff and decide. Their answer is theirs to give: " +
        "don't tell them it is done, and don't try to merge it yourself.\n\n" +
        "The proposal carries the fork's history — a version per edit you made to it — against the commit the fork " +
        "and the lesson last shared, so the reviewer reads your work as a sequence rather than as one lump. Still " +
        "finish the change before calling this: a proposal is somebody's queue, not a draft.\n\n" +
        "Calling it AGAIN from the same fork while a proposal is still open UPDATES that proposal rather than " +
        "opening another — same request, same discussion, new contents — which is what you want after the human " +
        "asks for a change. The title and body you pass are then ignored, since the ones already there are what " +
        "they have been reading. `updated` in the result says which happened.\n\n" +
        "Write the title and body for the reviewer, not for the log: say what changed and why it is an improvement, " +
        "so someone who has not read the diff can judge it.",
      inputSchema: {
        forkLessonId: z
          .string()
          .describe("The id of your fork — the lesson holding the changes."),
        lessonId: z
          .string()
          .optional()
          .describe(
            "The lesson to propose to. Defaults to the one the fork was forked from, which is nearly always right.",
          ),
        // Non-empty: the hub requires a title, and it would otherwise reject the
        // proposal only after the whole snapshot had been built and sent.
        title: z
          .string()
          .min(1)
          .describe(
            "One line naming the change, e.g. 'Fix three ungrounded answers in section 4'.",
          ),
        body: z
          .string()
          .optional()
          .describe(
            "The case for the change, in plain text: what you altered, and why. A note recording that an AI " +
              "assistant wrote it is appended automatically.",
          ),
      },
    },
    tool(async ({ forkLessonId, lessonId, title, body }) => {
      const {
        pull,
        lessonId: target,
        commit,
        changes,
        historyPushed,
        updated,
      } = await proposeChanges(api, {
        forkLessonId,
        lessonId,
        title,
        body,
        client: clientName(),
      });
      return text({
        proposalId: pull.id,
        lessonId: target,
        forkLessonId,
        title: pull.title,
        status: pull.status,
        ready: pull.ready,
        commit,
        changes,
        url: proposalUrl(target, pull.id),
        revision: pull.revision,
        note:
          (updated
            ? "This fork already had a proposal open, so it was UPDATED rather than duplicated — same proposal, " +
              "same discussion, new contents. Nothing has changed in the lesson itself."
            : "Proposal opened. Nothing has changed in the lesson itself.") +
          " Give the user the `url` so they can read the diff and merge or decline it. Poll " +
          "list_lesson_proposals if you need to know what they decided." +
          // The proposal is complete either way — its changes are stored with it.
          // This only means the fork's own history didn't catch up.
          (historyPushed
            ? ""
            : " (The proposal is complete, but the fork's own version history could not be updated, so the fork's " +
              "History tab won't show this change and a further proposal from it will re-send the same edits.)"),
      });
    }),
  );

  server.registerTool(
    "list_lesson_proposals",
    {
      title: "List a lesson's proposals",
      description:
        "List the proposals against a lesson, newest first — use this to check whether one you opened has been " +
        "merged, declined (status 'closed'), or is still waiting. `canReview` says whether you may merge them " +
        "yourself; merging is done in the web app, not over MCP, because it is the human's decision.",
      inputSchema: {
        lessonId: z
          .string()
          .describe("The lesson whose proposals you want to see."),
      },
    },
    tool(async ({ lessonId }) => {
      const { pulls, canReview } = await api.listPulls(lessonId);
      return text({
        canReview,
        proposals: pulls.map((pull) => ({
          ...pull,
          url: proposalUrl(lessonId, pull.id),
        })),
      });
    }),
  );

  server.registerTool(
    "get_lesson",
    {
      title: "Get a lesson",
      description:
        "Fetch one lesson including its full content document — use this to read a lesson before editing it, or to " +
        "study an existing lesson's structure as a template.",
      inputSchema: { id: z.string().describe("The lesson id.") },
    },
    tool(async ({ id }) => text(await api.getLesson(id))),
  );

  server.registerTool(
    "list_my_lessons",
    {
      title: "List my lessons",
      description:
        "List the lessons you have authored (both drafts and published), newest first. Returns summaries without the " +
        "full content.",
      inputSchema: {},
    },
    tool(async () => text({ lessons: await api.listMyLessons() })),
  );

  server.registerTool(
    "list_hub_lessons",
    {
      title: "Browse the hub",
      description:
        "List published lessons on the public hub, newest first. Useful for inspiration or to avoid duplicating an " +
        "existing lesson. Returns summaries only.",
      inputSchema: {},
    },
    tool(async () => text({ lessons: await api.listHubLessons() })),
  );

  server.registerTool(
    "set_lesson_published",
    {
      title: "Publish or unpublish a lesson",
      description:
        "Toggle a lesson you authored between a public-hub listing (published: true) and a private draft " +
        "(published: false), without changing its content.\n\n" +
        "Publishing puts the lesson on the public hub under the user's name, where anyone can read, copy and fork " +
        "it, so on a client that can put a question to the user this asks them to confirm it first and their answer " +
        "decides. Unpublishing is never confirmed — it only ever makes a lesson less visible.",
      inputSchema: {
        id: z.string().describe("The lesson id."),
        published: z
          .boolean()
          .describe(
            "true to publish to the hub, false to make it a private draft.",
          ),
      },
    },
    tool(async ({ id, published }) => {
      // PUT replaces the whole row, so carry the existing title/doc through.
      const current = await api.getLesson(id);
      const named = current.title ? `"${current.title}"` : `\`${id}\``;

      if (
        published &&
        current.published !== true &&
        !(await mayPublish(named))
      ) {
        return text(
          `Not published — the user was asked and said no, so ${named} is still a private draft. Its content is ` +
            "unchanged. Don't call set_lesson_published(true) for it again unless they ask you to.",
        );
      }

      const lesson = await api.updateLesson(id, {
        title: current.title,
        doc: current.doc,
        published,
      });
      return text({ ...lesson, url: hubUrl(lesson.id) });
    }),
  );

  server.registerTool(
    "delete_lesson",
    {
      title: "Delete a lesson",
      description:
        "Permanently delete a lesson you authored. This cannot be undone — the content and the whole version " +
        "history go with it. Prefer set_lesson_published(false) if you only want to hide it from the public hub.\n\n" +
        "On a client that can put a question to the user, this asks them to confirm before deleting, and their " +
        "answer decides it. Ask them yourself first regardless: not every client can show that prompt, and on the " +
        "ones that can't, calling this deletes the lesson outright.",
      inputSchema: { id: z.string().describe("The lesson id to delete.") },
    },
    tool(async ({ id }) => {
      // The lesson's title, so the user is asked about a lesson rather than
      // about an opaque id. Tolerant: failing to read it must not stop a
      // deletion the user asked for, so an unnamed lesson is still deletable.
      let named = `\`${id}\``;
      try {
        const lesson = await api.getLesson(id);
        if (lesson?.title) named = `"${lesson.title}"`;
      } catch {
        // Fall back to the id.
      }

      const confirmed = await askUser(
        `Permanently delete the lesson ${named}? This cannot be undone — its content and its whole version ` +
          "history go with it. To take it off the public hub without deleting it, say no and unpublish it instead.",
        "Delete it permanently",
      );
      if (confirmed === false) {
        return text(
          `Not deleted — the user was asked and said no, so ${named} is untouched. Do not call delete_lesson for ` +
            "it again unless they ask you to. If they only wanted it off the public hub, use " +
            "set_lesson_published(false).",
        );
      }

      await api.deleteLesson(id);
      return text(
        confirmed === true
          ? `Deleted lesson ${id}, with the user's confirmation.`
          : `Deleted lesson ${id}.`,
      );
    }),
  );

  // The one tool whose results are pictures rather than words. On a host that
  // renders MCP Apps the candidates come back as a picker the user scrolls and
  // clicks (see views.js); the click calls add_image over this same connection,
  // so the image lands in the lesson without a further turn. Everywhere else
  // this is the text result it has always been — the structured payload the
  // view reads is the same object the text block spells out.
  //
  // Which of those two is happening is the one thing the result must be clear
  // about, because the assistant's next move is opposite in each: pick, or stand
  // aside. See the `note` the handler chooses, and rendersViews().
  registerAppTool(
    server,
    "search_images",
    {
      title: "Search images",
      description:
        "Search Wikimedia Commons for freely-licensed images to illustrate a lesson. Returns a list of candidates, " +
        "each with a `ref` (its File: title), a `caption` carrying the required attribution, the licence/author, " +
        "dimensions, a `previewURL`, and a `source` page link.\n\n" +
        "WHO PICKS DEPENDS ON THE CLIENT, AND THE RESULT SAYS WHICH — read its `note` first and follow it. On a " +
        "client that can show the candidates as pictures, they are on screen and the USER picks: stop there, add " +
        "nothing, and wait to be told what they chose. On a text-only client, you pick — take the most relevant " +
        "`ref` and call add_image with it to download, store, and place the image.\n\n" +
        "Pixabay is not available over MCP (it needs a human verification step); only Wikimedia Commons is. If the " +
        "user doesn't like a chosen image, swap it later with add_image (after remove_block) or replace it in the " +
        "web editor, which keeps it in the same place.\n\n" +
        "Pass `lessonId` (and `sectionIndex`, if the picture is for a particular section) whenever you already know " +
        "where the image is going. It lets a user picking from the pictures place the image with the same click, " +
        "and costs a text-only client nothing — the list comes back either way.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "What to find a picture of, e.g. 'Saturn', 'red fox', 'Roman aqueduct'.",
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe("How many candidates to return (default 12, max 30)."),
        lessonId: z
          .string()
          .optional()
          .describe(
            "The lesson the picture is for, if you know it. Lets a user picking from the candidates add the image " +
              "themselves; you still get the same list back either way.",
          ),
        sectionIndex: z
          .number()
          .int()
          .optional()
          .describe(
            "0-based section the picture belongs to, used with lessonId. The image is placed first in that " +
              "section, above its paragraphs, as the standard asks.",
          ),
      },
      outputSchema: imageSearchOutputSchema,
      _meta: { ui: { resourceUri: IMAGE_PICKER_URI } },
    },
    tool(async ({ query, limit, lessonId, sectionIndex }) => {
      const perPage = Math.max(3, Math.min(Number(limit) || 12, 30));
      const hits = await searchWikimediaImages(query, { perPage });
      if (!hits.length) {
        const empty = { query, count: 0, images: [] };
        return {
          content: [
            {
              type: "text",
              text: `No images found on Wikimedia Commons for "${query}". Try more general or different terms.`,
            },
          ],
          structuredContent: empty,
        };
      }
      const picking = rendersViews(server);
      const result = {
        query,
        count: hits.length,
        images: hits,
        ...(lessonId ? { lessonId } : {}),
        ...(lessonId && Number.isInteger(sectionIndex)
          ? { placement: { sectionIndex, index: 0 } }
          : {}),
        note: picking ? PICKER_IS_THE_USERS : PICK_ONE_YOURSELF,
      };
      if (!picking) return { ...text(result), structuredContent: result };
      // Ahead of the payload, not buried in it: the candidates read as an
      // invitation to choose, and the model meets that invitation first.
      return {
        content: [
          { type: "text", text: PICKER_IS_THE_USERS },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
        structuredContent: result,
      };
    }),
  );

  server.registerTool(
    "add_image",
    {
      title: "Add an image to a lesson",
      description:
        "Download a Wikimedia Commons image (from a search_images `ref`), store its bytes, and insert it as an image " +
        "block in a lesson you authored. The picture's attribution is set as the caption automatically.\n\n" +
        "To place the image right next to a specific block you already know (e.g. the paragraph it illustrates), " +
        "pass `afterBlockId` (a block id from get_lesson) — this picks both the section and position for you and is " +
        "the most reliable way to choose placement. Otherwise choose the target section with `sectionId` (from " +
        "get_lesson) or `sectionIndex` (0-based), and optionally `index` for the exact position within it. If you " +
        "give none of these, the image is inserted at the end of the LAST section's prose, before any trailing " +
        "question block(s) — never buried after the quiz. Run search_images first to get a `ref` — and if its " +
        "result said the candidates are on screen for the user to pick from, don't call this until they have " +
        "picked one and you've been told which. To change an image later, remove_block it and add_image again, or " +
        "have the user replace it in the editor (which keeps its place).\n\n" +
        "The standard puts a section's image FIRST, above both paragraphs, so pass `sectionId`/`sectionIndex` with " +
        "`index: 0` rather than relying on the default. Prefer images that do double duty — reinforcing an answer " +
        "as well as illustrating — and diagrams that carry an argument over decorative photos; a letter-frequency " +
        "chart IS the reason a Caesar cipher fails, a stock padlock photo is not. Check the image doesn't " +
        "contradict the passage (a diagram showing a left shift under text describing A -> D will confuse). " +
        "Choose on content, not on file size: this tool downloads a downscaled rendering of whatever you pick, so " +
        "a large source is fine.",
      inputSchema: {
        lessonId: z
          .string()
          .describe("The id of the lesson to add the image to."),
        ref: z
          .string()
          .describe(
            "The image's File: title, taken from a search_images result's `ref`.",
          ),
        afterBlockId: z
          .string()
          .optional()
          .describe(
            "Insert the image directly after this block id (from get_lesson) — determines both the section and " +
              "position, and takes precedence over sectionId/sectionIndex/index. The most reliable way to place an " +
              "image next to the content it illustrates.",
          ),
        sectionId: z
          .string()
          .optional()
          .describe(
            "Target section id (from get_lesson), used when afterBlockId is omitted. Takes precedence over " +
              "sectionIndex.",
          ),
        sectionIndex: z
          .number()
          .int()
          .optional()
          .describe(
            "0-based target section. Used when afterBlockId/sectionId are omitted; defaults to the last section.",
          ),
        index: z
          .number()
          .int()
          .optional()
          .describe(
            "0-based position for the image within the section; omit to insert before the section's trailing " +
              "question block(s), if any (otherwise appended). Ignored when afterBlockId is given.",
          ),
        caption: z
          .string()
          .optional()
          .describe(
            "Override the auto attribution caption. Leave unset to keep the Commons attribution.",
          ),
        align: z
          .enum(["left", "center", "right"])
          .optional()
          .describe("Horizontal alignment (default center)."),
        size: z
          .string()
          .optional()
          .describe(
            'Display size key: "small", "medium", "large", or "full" (default full).',
          ),
      },
    },
    tool(
      async ({
        lessonId,
        ref,
        afterBlockId,
        sectionId,
        sectionIndex,
        index,
        caption,
        align,
        size,
      }) => {
        // Download the chosen image (+ its attribution) and store the bytes in R2.
        const resolved = await resolveWikimediaImage(ref);
        const imageRef = await api.uploadImage(resolved.bytes, resolved.mime);
        const finalCaption =
          typeof caption === "string" && caption.trim()
            ? caption
            : resolved.caption;

        const current = await api.getLesson(lessonId);
        const sections = current.doc?.sections || [];
        if (!sections.length) {
          throw new Error("That lesson has no sections to add an image to.");
        }

        // Resolve the target section + position. `afterBlockId` wins (it pins
        // both); otherwise resolve the section (explicit id, else index, else
        // last) and either use the given `index` or default to just before any
        // trailing question block(s), so a plain add_image never buries the
        // picture after the quiz.
        let targetSectionId;
        let insertIndex;
        if (afterBlockId) {
          const { sectionIndex: si, blockIndex } = findBlock(
            current.doc,
            afterBlockId,
            "add_image",
          );
          targetSectionId = sections[si].id;
          insertIndex = blockIndex + 1;
        } else {
          targetSectionId = sectionId;
          if (!targetSectionId) {
            const i = Number.isInteger(sectionIndex)
              ? sectionIndex
              : sections.length - 1;
            const section = sections[i];
            if (!section) {
              throw new Error(
                `sectionIndex ${sectionIndex} is out of range — the lesson has ${sections.length} section(s) (0–${sections.length - 1}).`,
              );
            }
            targetSectionId = section.id;
          }

          if (Number.isInteger(index)) {
            insertIndex = index;
          } else {
            const blocks =
              sections.find((s) => s.id === targetSectionId)?.blocks || [];
            let i = blocks.length;
            while (i > 0 && blocks[i - 1].type === "question") i--;
            insertIndex = i;
          }
        }

        // Insert via the same patch path as everything else, then save.
        const block = {
          type: "image",
          image: imageRef,
          width: resolved.width,
          height: resolved.height,
          caption: finalCaption,
        };
        if (align) block.align = align;
        if (size) block.size = size;

        const doc = applyPatch(current.doc, [
          {
            op: "add_block",
            sectionId: targetSectionId,
            block,
            index: insertIndex,
          },
        ]);
        const lesson = await api.updateLesson(lessonId, {
          title: doc.title || current.title,
          doc,
        });
        return text({
          ...lesson,
          url: hubUrl(lesson.id),
          history: await recordHistory({
            lessonId,
            doc,
            previousDoc: current.doc,
          }),
          caption: finalCaption,
          source: resolved.source,
          note:
            "Image added to the lesson. If it's not a good fit, remove_block it and add_image another, or replace " +
            "it in the web editor — the editor keeps a replaced image in the same place.",
        });
      },
    ),
  );

  // Live collaboration, where the transport can hold a session open. These need
  // the auth token directly (the room authenticates the WebSocket itself, rather
  // than through the API client) and they share this file's tool wrapper and
  // standard check, so what the assistant is told about a live edit matches what
  // it is told about a saved one.
  if (live && auth) {
    registerCollabTools(server, {
      config,
      auth,
      text,
      tool,
      standardFindings,
      clientName,
    });
  }
}

// The server's identifying metadata, shared by both transports.
//
// Keep `version` in step with apps/mcp/package.json and apps/mcp/manifest.json:
// this is the one clients actually see, so a stale value misnames the server in
// every client UI and bug report.
export const SERVER_INFO = {
  name: "spelling-creator-hub",
  version: "0.15.0",
};
