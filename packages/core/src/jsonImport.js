// Import a lesson from a JSON file produced by "Export JSON" (jsonExport.js) or
// by the MCP server's `create_lesson_file` tool. Unlike the DOCX import this is
// a lossless, exact-shape format, so we mostly validate and normalise: we accept
// the lesson-file envelope { format, version, doc } or a bare { title, sections }
// doc, ensure every section/block/word/answer has a stable id, drop anything we
// don't recognise, and reject files that aren't structured as a lesson.

import { newId } from "./id.js";
import { QUESTION_TYPES } from "./questions.js";
import { DEFAULT_IMAGE_SIZE, DEFAULT_IMAGE_ALIGN } from "./image.js";
import { LESSON_FILE_FORMAT } from "./lessonFile.js";

// Thrown when a file is readable but not a usable lesson. EditorPage surfaces
// the message and refuses to load it — same contract as DocxImportError.
export class JsonImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "JsonImportError";
  }
}

const QUESTION_KEYS = new Set(Object.keys(QUESTION_TYPES));

// Read a .json File and rebuild a lesson document ready for the editor. Resolves
// to { title, sections }; rejects (JsonImportError) when the file isn't a usable
// lesson.
export async function importJsonFile(file) {
  if (!file) throw new JsonImportError("No file was selected.");
  if (!/\.json$/i.test(file.name || "")) {
    throw new JsonImportError(
      "Please choose a .json lesson file — the kind you get from “Export JSON” here or from the Spelling Creator AI tool.",
    );
  }

  let text;
  try {
    text = await file.text();
  } catch {
    throw new JsonImportError("This file couldn't be read.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JsonImportError(
      "This file isn't valid JSON. It may be corrupted or not a lesson file.",
    );
  }

  return normalizeLessonFile(parsed);
}

// Accept either the lesson-file envelope { format, version, doc } or a bare doc
// { title, sections }, then normalise and validate it.
export function normalizeLessonFile(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new JsonImportError(
      "This file isn't a lesson — expected a JSON object.",
    );
  }
  // A wrong but explicit format marker is a clear, actionable error.
  if (parsed.format && parsed.format !== LESSON_FILE_FORMAT) {
    throw new JsonImportError(
      `This JSON file is “${parsed.format}”, not a Spelling Creator lesson.`,
    );
  }
  const docLike =
    parsed.doc && typeof parsed.doc === "object" ? parsed.doc : parsed;
  return normalizeDoc(docLike);
}

function normalizeDoc(docLike) {
  const rawSections = Array.isArray(docLike.sections) ? docLike.sections : null;
  if (!rawSections) {
    throw new JsonImportError(
      "This lesson file has no sections. A lesson needs a `sections` array.",
    );
  }

  const sections = rawSections
    .filter((s) => s && typeof s === "object")
    .map(normalizeSection)
    .filter((s) => s.blocks.length > 0);

  if (sections.length === 0) {
    throw new JsonImportError(
      "This lesson file has no readable sections or content.",
    );
  }

  const title =
    typeof docLike.title === "string" && docLike.title.trim()
      ? docLike.title
      : "Imported lesson";

  return { title, sections };
}

function normalizeSection(section) {
  const rawBlocks = Array.isArray(section.blocks) ? section.blocks : [];
  const blocks = rawBlocks.map(normalizeBlock).filter(Boolean);
  return {
    id: keepId(section.id),
    name:
      typeof section.name === "string" && section.name.trim()
        ? section.name
        : "Imported section",
    blocks,
  };
}

// Normalise one block to the exact editor shape, or return null to drop it.
function normalizeBlock(block) {
  if (!block || typeof block !== "object") return null;
  switch (block.type) {
    case "text":
      if (typeof block.text !== "string") return null;
      return { id: keepId(block.id), type: "text", text: block.text };

    case "spelling": {
      const words = (Array.isArray(block.words) ? block.words : [])
        .map(normalizeTextItem)
        .filter(Boolean);
      if (words.length === 0) return null;
      return { id: keepId(block.id), type: "spelling", words };
    }

    case "question":
      return normalizeQuestion(block);

    case "image": {
      // Preserve image blocks verbatim (binary ref / src / dimensions) and just
      // ensure the editor's required framing fields exist.
      if (!block.image && !block.src) return null;
      return {
        ...block,
        id: keepId(block.id),
        type: "image",
        size: block.size || DEFAULT_IMAGE_SIZE,
        align: block.align || DEFAULT_IMAGE_ALIGN,
      };
    }

    default:
      return null;
  }
}

function normalizeQuestion(block) {
  if (!QUESTION_KEYS.has(block.questionType)) return null;
  const prompt = typeof block.prompt === "string" ? block.prompt : "";
  const base = {
    id: keepId(block.id),
    type: "question",
    questionType: block.questionType,
    prompt,
  };
  switch (block.questionType) {
    case "number": {
      const steps = (Array.isArray(block.steps) ? block.steps : [])
        .map(normalizeTextItem)
        .filter(Boolean);
      return {
        ...base,
        answer: block.answer != null ? String(block.answer) : "",
        steps,
      };
    }
    case "single":
      return {
        ...base,
        answer: typeof block.answer === "string" ? block.answer : "",
      };
    case "multiple": {
      const answers = (Array.isArray(block.answers) ? block.answers : [])
        .map(normalizeTextItem)
        .filter(Boolean);
      if (answers.length === 0) answers.push({ id: newId(), text: "" });
      return { ...base, answers };
    }
    case "open":
      return base;
    case "background":
      return {
        ...base,
        answer: typeof block.answer === "string" ? block.answer : "",
      };
    default:
      return null;
  }
}

// A { id, text } row (spelling word or multiple-choice answer). Accepts a bare
// string too, so a hand-written file can use the simpler form.
function normalizeTextItem(item) {
  if (typeof item === "string") {
    const text = item.trim();
    return text ? { id: newId(), text } : null;
  }
  if (item && typeof item === "object" && typeof item.text === "string") {
    const text = item.text.trim();
    return text ? { id: keepId(item.id), text } : null;
  }
  return null;
}

// Reuse an existing string id, or mint a fresh one. Imported files normally
// already carry ids (the MCP tool and exporter generate them); we regenerate
// only what's missing so every node has a stable React/collaboration key.
function keepId(id) {
  return typeof id === "string" && id ? id : newId();
}
