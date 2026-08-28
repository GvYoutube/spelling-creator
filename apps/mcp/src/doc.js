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

import { extFromMime } from "./images.js";

export function newId() {
  return crypto.randomUUID();
}

const IMAGE_ALIGNS = ["left", "center", "right"];

export const QUESTION_TYPES = [
  "number",
  "single",
  "multiple",
  "paraphrase",
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
      return buildImageBlock(block, where);

    default:
      throw new Error(
        `${where}: unknown block type "${block.type}". Use one of: text, spelling, question, image.`,
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
    case "number": {
      // Stored as a string (the editor's number field), but accept a number too.
      if (block.answer == null || block.answer === "") {
        throw new Error(`${where}: a number question needs an "answer".`);
      }
      const rawSteps = Array.isArray(block.steps) ? block.steps : [];
      const steps = rawSteps
        .filter((t) => typeof t === "string" && t.trim())
        .map((text) => ({ id: newId(), text: text.trim() }));
      return { ...base, answer: String(block.answer), steps };
    }

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

    // Both are free written responses: the speller answers on their own paper,
    // so neither stores an answer.
    case "paraphrase":
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

// An image block references its bytes by content hash. The bytes are uploaded
// out of band by the add_image tool (which talks to Wikimedia Commons + R2), so
// here we only validate and normalise the resulting ref — the model never
// hand-writes one. Existing image blocks (from get_lesson) round-trip through
// this unchanged.
function buildImageBlock(block, where) {
  const ref = block.image;
  if (
    !ref ||
    typeof ref !== "object" ||
    typeof ref.hash !== "string" ||
    !ref.hash
  ) {
    throw new Error(
      `${where}: image blocks must carry an { image: { hash, mime, ext } } reference. ` +
        "Don't write these by hand — use the search_images and add_image tools, which download the image and upload its bytes.",
    );
  }
  const mime =
    typeof ref.mime === "string" && ref.mime ? ref.mime : "image/jpeg";
  const out = {
    id: newId(),
    type: "image",
    image: {
      hash: ref.hash,
      mime,
      ext: typeof ref.ext === "string" && ref.ext ? ref.ext : extFromMime(mime),
    },
  };
  if (Number.isFinite(block.width)) out.width = block.width;
  if (Number.isFinite(block.height)) out.height = block.height;
  if (typeof block.caption === "string") out.caption = block.caption;
  if (IMAGE_ALIGNS.includes(block.align)) out.align = block.align;
  if (typeof block.size === "string" && block.size) out.size = block.size;
  return out;
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

// Checking a built doc against the authoring standard lives in validate.js —
// buildDoc's job is only to reject input it cannot turn into a valid document at
// all (a text block with no text, an unknown block type), which it does by
// throwing. Everything that is well-formed but off-standard is decided there, so
// that a single pass covers create, update and patch alike.
