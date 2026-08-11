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

import { z } from "zod";
import { buildDoc, buildLessonFile, QUESTION_TYPES } from "./doc.js";
import { forkLesson, proposeChanges } from "./git.js";
import { applyPatch, findBlock } from "./patch.js";
import { searchWikimediaImages, resolveWikimediaImage } from "./wikimedia.js";
import { LESSON_STANDARDS } from "./standards.js";
import {
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
          "answers), open (free response), background (needs prior knowledge). Every answer except a background " +
          "one must appear, word for word, in that section's own passage; a background answer must NOT. Of the 7 " +
          "open questions in a section, the first 4 are TIGHT OPENS — open-ended but answerable in ONE WORD from " +
          "the speller's own everyday world, and crucially EASY, with no hard thinking, nothing abstract, and no " +
          'reference to the lesson ("Name a color of a crayon", "Name something found in a hospital"). The last 3 ' +
          'are EXTENDED OPENS, inviting a full sentence ("In your own words, explain…", "…Defend your answer.").',
      ),
    prompt: z
      .string()
      .optional()
      .describe('For type "question": the question text.'),
    answer: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Answer for number/single/background questions."),
    answers: z
      .array(z.string())
      .optional()
      .describe(
        'Accepted answers for a "multiple" (orange) question: 2-4 of them, each a SINGLE WORD appearing verbatim ' +
          'in that section\'s passage. These are simple retrieval — "Name a material used to build the dam" -> ' +
          'CONCRETE, STEEL, ROCK. Don\'t paraphrase (if the text says "superheated", HOT is not an accepted ' +
          "answer), don't ask general knowledge (\"name an ocean\" is a background question), and don't use long " +
          "evidence phrases — a speller pointing at a letterboard has to spell every word.",
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
        "words = the harder learning vocabulary, kept separate from the spelling list), " +
        "then a spelling block of 4 words (6-9 letters, thematically related but NOT drawn " +
        "from the passage's ALL-CAPS vocabulary), then 15 question blocks about THIS " +
        "section's content, in this fixed order: 3 single, 1 number (fill-in-the-blank), " +
        "1 number (word problem, with steps), 2 multiple (2-4 single-word answers each), " +
        "1 background, 4 open (tight — easy everyday one-word answers), 3 open (extended — " +
        "full-sentence answers). Every section ends " +
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
      "order. Never use it to get past a defect you could fix; the rejection message says exactly what to change.",
  );

// Findings carry an internal level and dedupe key; the assistant only needs to
// know what is wrong and where.
function toWireWarnings(warnings) {
  return warnings.map(({ code, section, message }) =>
    section == null ? { code, message } : { code, section, message },
  );
}

/**
 * Run the authoring standard over a lesson about to be written.
 *
 * Throws when it fails, which the `tool()` wrapper turns into a readable isError
 * result — so a rejected lesson is never saved, and the assistant gets a message
 * naming every defect and its fix. Returns the warnings to ride along with a
 * successful write.
 *
 * `baselineDoc` (patch_lesson only) holds the lesson as it was before the edit,
 * and limits both errors and warnings to the ones the edit actually introduced.
 * Without it, a one-line tweak to a lesson written in the web editor — or written
 * before these rules existed — would be blocked by defects the caller never
 * touched and may not be able to fix.
 *
 * @param {{ doc: any, rawBlocks?: any[], skipValidation?: boolean, baselineDoc?: any }} args
 * @returns {Array<{ code: string, section?: number, message: string }>}
 */
function checkStandard({
  doc,
  rawBlocks = [],
  skipValidation = false,
  baselineDoc = null,
}) {
  if (skipValidation) return [];

  const { errors, warnings } = validateLesson(doc);
  let failures = [...validateInput(rawBlocks), ...errors];
  let flags = warnings;

  if (baselineDoc) {
    const before = validateLesson(baselineDoc);
    failures = newFindings(before.errors, failures);
    flags = newFindings(before.warnings, flags);
  }

  if (failures.length) throw new Error(validationErrorMessage(failures));
  return toWireWarnings(flags);
}

/**
 * Attach all tools to an MCP server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ api: ReturnType<import('./api.js').createApi>, config: ReturnType<import('./config.js').loadConfig> }} ctx
 */
export function registerTools(server, ctx) {
  const { api, config } = ctx;
  const hubUrl = (id) => `${config.apiUrl}/hub/${id}`;
  const proposalUrl = (lessonId, pullId) =>
    `${hubUrl(lessonId)}/proposals/${pullId}`;

  // Which MCP client is connected, by its own account of itself — recorded on a
  // proposal so a reviewer can see the changes came from an assistant rather
  // than from them (see proposalBody in git.js). Only known once the client has
  // initialised, and not every client sends it, so this is best-effort.
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
      const warnings = checkStandard({
        doc,
        rawBlocks: inputBlocksFromSections(sections),
        skipValidation,
      });
      const lesson = await api.createLesson({
        title: doc.title,
        doc,
        published,
      });
      const result = {
        ...lesson,
        url: hubUrl(lesson.id),
        note: published
          ? "Published to the public hub."
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
      const warnings = checkStandard({
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
        "to the problems your edit introduces.",
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
        skipValidation: skipValidationSchema,
      },
    },
    tool(async ({ id, title, sections, published, skipValidation }) => {
      const doc = buildDoc({ title, sections });
      // A full replace, so the caller owns every defect in the result.
      const warnings = checkStandard({
        doc,
        rawBlocks: inputBlocksFromSections(sections),
        skipValidation,
      });
      const lesson = await api.updateLesson(id, {
        title: doc.title,
        doc,
        published,
      });
      const result = { ...lesson, url: hubUrl(lesson.id) };
      if (warnings.length) result.warnings = warnings;
      return text(result);
    }),
  );

  server.registerTool(
    "patch_lesson",
    {
      title: "Patch a lesson",
      description:
        "Edit a lesson you authored with a small list of operations, instead of resending the whole document. " +
        "Prefer this over update_lesson for tweaks. Call get_lesson first to read the current sections/blocks and " +
        "their ids; operations address them by id. The server fetches the lesson, applies the operations in order, " +
        "then saves the result.\n\n" +
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
        "block a small tweak.",
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
        skipValidation: skipValidationSchema,
      },
    },
    tool(async ({ id, operations, published, skipValidation }) => {
      // Fetch current content, apply the diff in memory, then save (the Worker
      // only offers a full-replace PUT — see api.updateLesson).
      const current = await api.getLesson(id);
      const doc = applyPatch(current.doc, operations);
      // Only the defects this patch introduced: a small edit to a lesson written
      // elsewhere shouldn't be blocked by what was already there.
      const warnings = checkStandard({
        doc,
        rawBlocks: inputBlocksFromOperations(operations),
        skipValidation,
        baselineDoc: current.doc,
      });
      const lesson = await api.updateLesson(id, {
        title: doc.title || current.title,
        doc,
        published,
      });
      const result = { ...lesson, url: hubUrl(lesson.id) };
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
        "  overwrites it immediately and there is nothing to review; forking leaves the lesson untouched until " +
        "  they merge, and they can decline.\n\n" +
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
        "The proposal carries ONE commit holding the fork as it now stands, so make all your edits before calling " +
        "this.\n\n" +
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
        "(published: false), without changing its content.",
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
        "Permanently delete a lesson you authored. This cannot be undone. Prefer set_lesson_published(false) if you " +
        "only want to hide it from the public hub.",
      inputSchema: { id: z.string().describe("The lesson id to delete.") },
    },
    tool(async ({ id }) => {
      await api.deleteLesson(id);
      return text(`Deleted lesson ${id}.`);
    }),
  );

  server.registerTool(
    "search_images",
    {
      title: "Search images",
      description:
        "Search Wikimedia Commons for freely-licensed images to illustrate a lesson. Returns a list of candidates, " +
        "each with a `ref` (its File: title), a `caption` carrying the required attribution, the licence/author, " +
        "dimensions, a `previewURL`, and a `source` page link.\n\n" +
        "Pick the most relevant result and call add_image with its `ref` to download it, store it, and place it in a " +
        "lesson. Pixabay is not available over MCP (it needs a human verification step); only Wikimedia Commons is. " +
        "If the user doesn't like a chosen image, swap it later with add_image (after remove_block) or replace it in " +
        "the web editor, which keeps it in the same place.",
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
      },
    },
    tool(async ({ query, limit }) => {
      const perPage = Math.max(3, Math.min(Number(limit) || 12, 30));
      const hits = await searchWikimediaImages(query, { perPage });
      if (!hits.length) {
        return text(
          `No images found on Wikimedia Commons for "${query}". Try more general or different terms.`,
        );
      }
      return text({
        query,
        count: hits.length,
        images: hits,
        note:
          "Choose the best `ref` and call add_image to insert it. The `caption` carries the licence attribution " +
          "Commons requires — keep it on the image.",
      });
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
        "question block(s) — never buried after the quiz. Run search_images first to get a `ref`. To change an " +
        "image later, remove_block it and add_image again, or have the user replace it in the editor (which keeps " +
        "its place).\n\n" +
        "The standard puts a section's image FIRST, above both paragraphs, so pass `sectionId`/`sectionIndex` with " +
        "`index: 0` rather than relying on the default. Prefer images that do double duty — reinforcing an answer " +
        "as well as illustrating — and diagrams that carry an argument over decorative photos; a letter-frequency " +
        "chart IS the reason a Caesar cipher fails, a stock padlock photo is not. Check the image doesn't " +
        "contradict the passage (a diagram showing a left shift under text describing A -> D will confuse). Source " +
        'files roughly 1000-1900px wide upload reliably; a much larger one can fail with a Cloudflare "Worker ' +
        'exceeded resource limits" error, which is a size problem rather than a transient one — pick a smaller ' +
        "candidate instead of retrying the same file.",
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
          caption: finalCaption,
          source: resolved.source,
          note:
            "Image added to the lesson. If it's not a good fit, remove_block it and add_image another, or replace " +
            "it in the web editor — the editor keeps a replaced image in the same place.",
        });
      },
    ),
  );
}

// The server's identifying metadata, shared by both transports.
//
// Keep `version` in step with apps/mcp/package.json and apps/mcp/manifest.json:
// this is the one clients actually see, so a stale value misnames the server in
// every client UI and bug report.
export const SERVER_INFO = {
  name: "spelling-creator-hub",
  version: "0.3.0",
};
