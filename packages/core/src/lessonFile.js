// The .json lesson-file envelope — a lossless round-trip of the editor's own
// document model (unlike the DOCX export, which flattens to prose).
//
// Three things produce or consume this shape: the editor's "Export JSON" button
// (./browser/jsonExport.js), the "Import JSON" button (./jsonImport.js), and the
// MCP server's `create_lesson_file` tool. Keeping the envelope here means they
// agree by construction rather than by comment.

export const LESSON_FILE_FORMAT = "spelling-creator-lesson";
export const LESSON_FILE_VERSION = 1;

/**
 * Wrap a doc in the importable lesson-file envelope.
 * @param {object} doc
 * @returns {{format: string, version: number, doc: object}}
 */
export function buildLessonFile(doc) {
  return {
    format: LESSON_FILE_FORMAT,
    version: LESSON_FILE_VERSION,
    doc: { title: doc.title, sections: doc.sections },
  };
}

/**
 * A filesystem-safe `.json` name derived from the lesson title.
 * @param {string} [title]
 * @returns {string}
 */
export function lessonFileName(title) {
  const base = (title || "lesson")
    .trim()
    .replace(/[^a-z0-9\-_ ]/gi, "")
    .replace(/\s+/g, "-");
  return `${base || "lesson"}.json`;
}
