// Build the canonical editor document (`doc`) from the LLM-friendly lesson input
// the tools accept. The Worker stores `doc` verbatim and the web editor renders
// it, so the shapes here must match the editor's exactly. They are kept in sync
// with:
//   • apps/web/src/lib/questions.js  (question block shapes, the five types)
//   • apps/web/src/lib/spelling.js   (spelling block shape)
//   • apps/web/src/lib/id.js         (id generation)
//
// The canonical doc is:
//   { title, sections: [ { id, name, blocks: [ Block, ... ] } ] }
// Blocks carry a stable `id`; we generate every id here so callers (and the AI
// assistant driving them) never have to. Input is intentionally simpler than the
// stored shape — e.g. spelling words are plain strings here, objects in the doc.

export function newId() {
  return crypto.randomUUID();
}

export const QUESTION_TYPES = [
  "number",
  "single",
  "multiple",
  "open",
  "background",
];

// Map one input block to its stored form. Throws a descriptive Error on bad
// input so the assistant gets actionable feedback it can correct. Exported so
// the patch logic (patch.js) can build single blocks the same way.
export function buildBlock(block, where) {
  if (!block || typeof block !== "object") {
    throw new Error(`${where}: each block must be an object.`);
  }
  switch (block.type) {
    case "text": {
      if (typeof block.text !== "string") {
        throw new Error(`${where}: a text block needs a "text" string.`);
      }
      return { id: newId(), type: "text", text: block.text };
    }

    case "spelling": {
      const raw = Array.isArray(block.words) ? block.words : [];
      const words = raw
        .filter((w) => typeof w === "string" && w.trim())
        .map((text) => ({ id: newId(), text: text.trim() }));
      if (words.length === 0) {
        throw new Error(
          `${where}: a spelling block needs a non-empty "words" array of strings.`,
        );
      }
      return { id: newId(), type: "spelling", words };
    }

    case "question":
      return buildQuestionBlock(block, where);

    case "image":
      throw new Error(
        `${where}: image blocks aren't supported over MCP yet (they need a separate binary upload). Use text and spelling/question blocks.`,
      );

    default:
      throw new Error(
        `${where}: unknown block type "${block.type}". Use one of: text, spelling, question.`,
      );
  }
}

function buildQuestionBlock(block, where) {
  const { questionType, prompt } = block;
  if (!QUESTION_TYPES.includes(questionType)) {
    throw new Error(
      `${where}: question block needs "questionType" of ${QUESTION_TYPES.join(", ")}.`,
    );
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error(`${where}: question block needs a non-empty "prompt".`);
  }
  const base = { id: newId(), type: "question", questionType, prompt };

  switch (questionType) {
    case "number":
      // Stored as a string (the editor's number field), but accept a number too.
      if (block.answer == null || block.answer === "") {
        throw new Error(`${where}: a number question needs an "answer".`);
      }
      return { ...base, answer: String(block.answer) };

    case "single":
      if (typeof block.answer !== "string" || !block.answer.trim()) {
        throw new Error(
          `${where}: a single-answer question needs an "answer" string.`,
        );
      }
      return { ...base, answer: block.answer };

    case "multiple": {
      const raw = Array.isArray(block.answers) ? block.answers : [];
      const answers = raw
        .filter((t) => typeof t === "string" && t.trim())
        .map((text) => ({ id: newId(), text: text.trim() }));
      if (answers.length === 0) {
        throw new Error(
          `${where}: a multiple-answer question needs a non-empty "answers" array of strings.`,
        );
      }
      return { ...base, answers };
    }

    case "open":
      return { ...base };

    case "background":
      if (typeof block.answer !== "string" || !block.answer.trim()) {
        throw new Error(
          `${where}: a background question needs an "answer" string.`,
        );
      }
      return {
        ...base,
        background:
          typeof block.background === "string" ? block.background : "",
        answer: block.answer,
      };

    default:
      return base;
  }
}

/**
 * Build a full canonical doc from lesson input.
 * @param {{ title?: string, sections: Array<{ name?: string, blocks?: any[] }> }} input
 * @returns {{ title: string, sections: any[] }}
 */
export function buildDoc(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Lesson must be an object with a title and sections.");
  }
  const sections = Array.isArray(input.sections) ? input.sections : [];
  if (sections.length === 0) {
    throw new Error("A lesson needs at least one section.");
  }

  const title = (input.title || "Untitled Lesson").toString();

  const builtSections = sections.map((section, i) => {
    if (!section || typeof section !== "object") {
      throw new Error(
        `Section ${i + 1} must be an object with a name and blocks.`,
      );
    }
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    const builtBlocks = blocks.map((block, j) =>
      buildBlock(block, `Section ${i + 1}, block ${j + 1}`),
    );
    return {
      id: newId(),
      name: (section.name || `Section ${i + 1}`).toString(),
      blocks: builtBlocks,
    };
  });

  return { title, sections: builtSections };
}

// The on-disk lesson-file format produced by create_lesson_file (here) and by
// the web editor's "Export JSON". The web app's "Import JSON" button reads it
// back. Keep this format marker and shape in sync with apps/web/src/lib/
// jsonImport.js and jsonExport.js so a file from either side imports cleanly.
export const LESSON_FILE_FORMAT = "spelling-creator-lesson";
export const LESSON_FILE_VERSION = 1;

/**
 * Wrap a built doc in the importable lesson-file envelope.
 * @param {{ title: string, sections: any[] }} doc
 */
export function buildLessonFile(doc) {
  return {
    format: LESSON_FILE_FORMAT,
    version: LESSON_FILE_VERSION,
    doc,
  };
}

/**
 * Soft, non-blocking checks on a built doc. Returns human-readable warnings the
 * tools surface back in their result so the assistant can fix the lesson's shape
 * without the publish itself failing. Currently enforces the convention that
 * every section ends with a question about its own content (see tools.js).
 * @param {{ sections?: any[] }} doc
 * @returns {string[]}
 */
export function lessonWarnings(doc) {
  const warnings = [];
  (doc?.sections || []).forEach((section, i) => {
    const blocks = section.blocks || [];
    const hasQuestion = blocks.some((b) => b.type === "question");
    if (!hasQuestion) {
      const label = section.name || `Section ${i + 1}`;
      warnings.push(
        `Section "${label}" has no question. Each section should end with at least one question about its content — add one, or move questions out of any separate quiz section.`,
      );
    }
  });
  return warnings;
}
