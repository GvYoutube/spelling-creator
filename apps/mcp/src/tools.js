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
import {
  buildDoc,
  buildLessonFile,
  lessonWarnings,
  QUESTION_TYPES,
} from "./doc.js";
import { applyPatch, findBlock } from "./patch.js";
import { searchWikimediaImages, resolveWikimediaImage } from "./wikimedia.js";

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
        'For type "question": number (numeric answer), single (one text answer), multiple (several accepted answers), open (free response), background (needs prior knowledge).',
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
      .describe('Accepted answers for a "multiple" question.'),
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
        'For type "image": display size key (e.g. "small", "medium", "full").',
      ),
  })
  .describe("A lesson content block.");

const sectionSchema = z.object({
  name: z.string().optional().describe("Heading for this section."),
  blocks: z
    .array(blockSchema)
    .describe(
      "The blocks in this section, in order. By default a section has about TWO " +
        "text paragraphs (~2 ALL-CAPS spelling words each), then ends with one or " +
        "more question blocks about THIS section's content. Every section should " +
        "end with its own question(s) — do not collect them into a separate quiz " +
        "section at the end.",
    ),
});

const sectionsSchema = z
  .array(sectionSchema)
  .min(1)
  .describe(
    "The lesson's sections, in order. Default to about THREE sections unless the " +
      "user asks for more or fewer. Each section is self-contained: ~2 paragraphs " +
      "of prose followed by question(s) on that section.",
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

/**
 * Attach all tools to an MCP server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ api: ReturnType<import('./api.js').createApi>, config: ReturnType<import('./config.js').loadConfig> }} ctx
 */
export function registerTools(server, ctx) {
  const { api, config } = ctx;
  const hubUrl = (id) => `${config.apiUrl}/hub/${id}`;

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
        "spelling (an explicit word list), and question (number/single/multiple/open/background).\n\n" +
        "DEFAULT STRUCTURE (unless the user asks otherwise): about 3 sections; each section has roughly 2 text " +
        "paragraphs and then ENDS with one or more question blocks about that section. Put questions after EVERY " +
        "section — do NOT gather them into a single quiz section at the end. Honour the user when they request a " +
        "different length, more/fewer questions, or a specific shape.",
      inputSchema: {
        title: z.string().describe("The lesson title / topic."),
        sections: sectionsSchema,
        published: z
          .boolean()
          .optional()
          .describe(
            "true = publish to the public hub now; false (default) = save as a private draft.",
          ),
      },
    },
    tool(async ({ title, sections, published = false }) => {
      const doc = buildDoc({ title, sections });
      const warnings = lessonWarnings(doc);
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
        "explicit word list), and question (number/single/multiple/open/background). DEFAULT STRUCTURE (unless asked " +
        "otherwise): about 3 sections; each has roughly 2 text paragraphs and ENDS with one or more question blocks " +
        "about that section.",
      inputSchema: {
        title: z.string().describe("The lesson title / topic."),
        sections: sectionsSchema,
      },
    },
    tool(async ({ title, sections }) => {
      const doc = buildDoc({ title, sections });
      const warnings = lessonWarnings(doc);
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
        "Optionally flip published to move between draft and public.",
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
      },
    },
    tool(async ({ id, title, sections, published }) => {
      const doc = buildDoc({ title, sections });
      const warnings = lessonWarnings(doc);
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
        "`block`/`blocks` use the same shape as create_lesson. `index` is 0-based; omit it to append.",
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
      },
    },
    tool(async ({ id, operations, published }) => {
      // Fetch current content, apply the diff in memory, then save (the Worker
      // only offers a full-replace PUT — see api.updateLesson).
      const current = await api.getLesson(id);
      const doc = applyPatch(current.doc, operations);
      const warnings = lessonWarnings(doc);
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
        "its place).",
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
            'Display size key, e.g. "small", "medium", "full" (default full).',
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
export const SERVER_INFO = {
  name: "spelling-creator-hub",
  version: "0.1.3",
};
