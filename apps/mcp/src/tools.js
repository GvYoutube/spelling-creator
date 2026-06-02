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
import { buildDoc, lessonWarnings, QUESTION_TYPES } from "./doc.js";

// One content block, described richly so the model fills the right fields per
// type. buildDoc() does the strict per-type validation and returns clear errors
// the assistant can act on, so this schema stays deliberately lenient.
const blockSchema = z
  .object({
    type: z
      .enum(["text", "spelling", "question"])
      .describe(
        "text = a paragraph of lesson prose (put any words you're teaching the spelling of in ALL CAPS); " +
          "spelling = an explicit list of spelling words; question = a quiz question.",
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
        'For type "question": number (numeric answer), single (one text answer), multiple (several accepted answers), open (free response with an example), background (needs prior knowledge).',
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
    exampleAnswer: z
      .string()
      .optional()
      .describe('Example answer for an "open" question.'),
    background: z
      .string()
      .optional()
      .describe('The prior-knowledge context for a "background" question.'),
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

// Render a value as a text content result (the MCP content shape).
function text(value) {
  const body =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: body }] };
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
}

// The server's identifying metadata, shared by both transports.
export const SERVER_INFO = {
  name: "spelling-creator-hub",
  version: "0.1.2",
};
