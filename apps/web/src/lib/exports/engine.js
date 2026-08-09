// The document export/import pipeline, isolated into its own chunk.
//
// Everything re-exported here reaches `docx`, `mammoth`, `html2pdf.js`,
// `html2canvas` and `jszip` — together the largest single cluster in the
// dependency graph, and about three quarters of what the app used to preload on
// every page view. None of it is needed until someone clicks Export or Import,
// so nothing imports this module directly; callers go through load.js.
//
// Preview is deliberately *not* here: the preview dialog renders the lesson
// model directly with <LessonView>, the same component the public lesson page
// uses, so looking at a lesson never fetches this chunk.
//
// It is one chunk rather than four because the entry points share almost all of
// their weight: the PDF path builds the docx and converts it with mammoth,
// which is also what the importer uses. Splitting them further would duplicate
// megabytes across chunks to save nothing.

export { exportDocx } from "@spelling-creator/core/browser/docxExport";
export { importDocxFile } from "@spelling-creator/core/browser/docxImport";
export { exportPdf } from "@spelling-creator/core/browser/pdfExport";
// Saving to Drive uploads a .docx, so it builds one the same way — it belongs
// in this chunk rather than dragging `docx` back into the eager graph on its own.
export { saveToGoogleDrive } from "@spelling-creator/core/browser/googleDrive";
