// Export a lesson as a self-contained JSON file. This is a lossless round-trip
// of the editor's own document model (unlike the DOCX export, which flattens to
// prose), and is the format the MCP server's `create_lesson_file` tool emits and
// the "Import JSON" button reads back. Keep the envelope in sync with
// jsonImport.js and apps/mcp/src/doc.js (buildLessonFile).

export const LESSON_FILE_FORMAT = "spelling-creator-lesson";
export const LESSON_FILE_VERSION = 1;

// Wrap a doc in the importable lesson-file envelope.
export function buildLessonFile(doc) {
  return {
    format: LESSON_FILE_FORMAT,
    version: LESSON_FILE_VERSION,
    doc: { title: doc.title, sections: doc.sections },
  };
}

function safeFileName(title) {
  const base = (title || "lesson")
    .trim()
    .replace(/[^a-z0-9\-_ ]/gi, "")
    .replace(/\s+/g, "-");
  return `${base || "lesson"}.json`;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Serialise the doc and download it as a .json file.
export function exportJson(doc) {
  const json = JSON.stringify(buildLessonFile(doc), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  triggerDownload(blob, safeFileName(doc.title));
}
