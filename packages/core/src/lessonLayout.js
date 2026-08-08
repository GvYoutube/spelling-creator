// Presentation constants shared by every way a lesson is rendered: the docx
// export, the mammoth-backed HTML preview, the PDF, and the read-only viewer on
// the public lesson page.
//
// These live here — outside `browser/` and free of dependencies — deliberately.
// They used to sit next to the code that first needed them (`DOCX_MAX_IMAGE_WIDTH`
// in browser/docxExport.js, `PREVIEW_STYLES` in browser/htmlPreview.js), which
// meant importing either constant dragged in `docx` + `mammoth` (~1.1 MB of
// source between them). LessonView.jsx wants only these two values, so it was
// paying for the whole Word pipeline on the public `/hub/:id` route.
//
// Being outside `browser/` is also what lets the server render a lesson: the
// `core/browser/*` tier needs a DOM and is unreachable from the Worker by
// design (see .oxlintrc.json), and `/hub/:id` is server-rendered.

// Max image width inside the docx page (in px; docx maps px→EMU internally). The
// preview, PDF and viewer paths all reuse this number so an image is the
// identical size everywhere.
export const DOCX_MAX_IMAGE_WIDTH = 480;

// Styles applied to the mammoth-generated HTML shown in the preview dialog, and
// to the viewer, which reproduces the same look without building a document.
export const PREVIEW_STYLES = `
  .s2c-preview-root {
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.5;
    font-size: 14px;
  }
  .s2c-preview-root h1 {
    text-align: center;
    font-size: 26px;
    margin: 0 0 24px;
    color: #1a1a1a;
  }
  .s2c-preview-root h2 {
    font-size: 19px;
    color: #3b5bdb;
    border-bottom: 2px solid #3b5bdb;
    padding-bottom: 4px;
    margin: 22px 0 12px;
  }
  .s2c-preview-root p { margin: 0 0 10px; }
  .s2c-preview-root figure { margin: 0; }
  .s2c-preview-root img {
    display: block;
    width: 100%;
    height: auto;
  }
`;
