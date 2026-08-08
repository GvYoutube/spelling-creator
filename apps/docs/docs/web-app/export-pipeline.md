---
title: How the export pipeline works
sidebar_position: 14
---

# How the export pipeline works

1. The lesson state (`{ title, sections: [{ name, blocks: [...] }] }`) is turned
   into a `docx` `Document` in `@spelling-creator/core/browser/docxExport`.
2. **DOCX export** packs that document to a Blob and downloads it.
3. **PDF print** (`@spelling-creator/core/browser/pdfExport`) packs the same
   document, converts it to HTML with `mammoth`, applies print styles, and
   renders it to PDF with `html2pdf.js`. Using one shared document builder keeps
   the two outputs in sync.
4. **Preview** (`browser/htmlPreview`) and **import** (`browser/docxImport`) are
   the same machinery in the other directions, and **Save to Google Docs**
   uploads the very same `.docx`.

## It loads on demand

Together those libraries — `docx`, `mammoth`, `html2pdf.js`, `html2canvas`,
`jszip` — are the largest single cluster in the dependency graph: about 390 kB
gzipped. None of it is needed until someone clicks Export, Preview, Import or
Save to Drive, so it lives in its own chunk behind
`src/lib/exports/load.js`, in the same shape as the git engine:

```js
const { exportDocx } = await loadExportEngine();
await exportDocx(doc);
```

`src/lib/exports/engine.js` is the chunk; nothing imports it directly. It's one
chunk rather than five because the entry points share nearly all their weight —
the PDF path renders the HTML preview, which builds the docx and converts it
with mammoth, which is also what the importer uses.

### The constants trap

`DOCX_MAX_IMAGE_WIDTH` and `PREVIEW_STYLES` live in
`@spelling-creator/core/lessonLayout`, **not** beside the code that first needed
them. They used to sit in `browser/docxExport` and `browser/htmlPreview`, which
meant `LessonView.jsx` — wanting two constants, and rendering on the public
`/hub/:id` page — pulled the entire Word toolchain into the bundle every visitor
downloaded.

Being outside `browser/` is also what lets the server render a lesson at all:
that tier needs a DOM and is unreachable from the Worker by design, and
`/hub/:id` is [server-rendered](./server-rendering.md).

If you add a shared constant to any of these modules, put it in `lessonLayout`
and re-export it, rather than importing the module for the constant's sake.
