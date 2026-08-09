// The one presentation constant every way of rendering a lesson shares: the docx
// export, the mammoth-backed PDF, and the read-only viewer (LessonView) that
// draws both the public lesson page and the editor's preview dialog.
//
// This lives here — outside `browser/` and free of dependencies — deliberately.
// It used to sit next to the code that first needed it (browser/docxExport.js),
// which meant importing the constant dragged in `docx` + `mammoth` (~1.1 MB of
// source). LessonView.jsx wants only this value, so it was paying for the whole
// Word pipeline just to show a lesson.
//
// Being outside `browser/` is also what lets the server render a lesson: the
// `core/browser/*` tier needs a DOM and is unreachable from the Worker by
// design (see .oxlintrc.json), and `/hub/:id` is server-rendered.

// Max image width inside the docx page (in px; docx maps px→EMU internally). The
// PDF and viewer paths both reuse this number so an image is the identical size
// everywhere.
export const DOCX_MAX_IMAGE_WIDTH = 480;
