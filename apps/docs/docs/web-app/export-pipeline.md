---
title: How the export pipeline works
sidebar_position: 14
---

# How the export pipeline works

1. The lesson state (`{ title, sections: [{ name, blocks: [...] }] }`) is turned
   into a `docx` `Document` in `src/lib/docxExport.js`.
2. **DOCX export** packs that document to a Blob and downloads it.
3. **PDF print** (`src/lib/pdfExport.js`) packs the same document, converts it to
   HTML with `mammoth`, applies print styles, and renders it to PDF with
   `html2pdf.js`. Using one shared document builder keeps the two outputs in sync.
