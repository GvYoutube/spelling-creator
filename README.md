# Spelling Lesson Maker

A web app for building and printing **Spelling** (also known as S2C) lessons.
Create a document, add named sections, and fill each section with text and
images. Export the finished lesson as a Word document (`.docx`) or print it to
PDF.

Built with **React + Vite + MUI**, using [`docx`](https://docx.js.org) for Word
export and [`html2pdf.js`](https://github.com/eKoopmans/html2pdf.js) (via
[`mammoth`](https://github.com/mwilliamson/mammoth.js) docx→HTML conversion) for
PDF printing.

## Features

- **Document title** – name the whole lesson.
- **Add sections** with the floating **+** button; each new section is named in a dialog.
- **Text and image blocks** inside any section — add, caption, reorder, or delete them.
- **Reorder / delete** sections and blocks with inline controls.
- **Export DOCX** – downloads a formatted `.docx`.
- **Print PDF** – builds the docx, converts it to HTML with mammoth, then renders
  a PDF with html2pdf.js so the printout mirrors the Word document.
- **Auto-save** – your work is kept in `localStorage` between reloads.

## Getting started

```bash
pnpm install
pnpm dev      # start the dev server (http://localhost:5173)
pnpm build    # production build into dist/
pnpm preview  # preview the production build
```

## How the export pipeline works

1. The lesson state (`{ title, sections: [{ name, blocks: [...] }] }`) is turned
   into a `docx` `Document` in `src/lib/docxExport.js`.
2. **DOCX export** packs that document to a Blob and downloads it.
3. **PDF print** (`src/lib/pdfExport.js`) packs the same document, converts it to
   HTML with `mammoth`, applies print styles, and renders it to PDF with
   `html2pdf.js`. Using one shared document builder keeps the two outputs in sync.

## Project structure

```
src/
  App.jsx                 app shell: title, toolbar, section list, + button
  theme.js                MUI theme
  components/
    SectionCard.jsx       a named section with its content blocks
    ContentBlock.jsx      a single text or image block
  lib/
    docxExport.js         build + download the .docx
    pdfExport.js          docx -> html (mammoth) -> pdf (html2pdf.js)
    image.js              file reading, sizing, data-url helpers
    storage.js            localStorage auto-save
    id.js                 id generation
```
