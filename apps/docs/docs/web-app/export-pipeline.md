---
title: How the export pipeline works
---

# How the export pipeline works

1. The lesson state (`{ title, sections: [{ name, blocks: [...] }] }`) is turned
   into a `docx` `Document` in `@spelling-creator/core/browser/docxExport`.
2. **DOCX export** packs that document to a Blob and downloads it.
3. **PDF print** (`@spelling-creator/core/browser/pdfExport`) packs the same
   document, converts it to HTML with `mammoth`, applies print styles, and
   renders it to PDF with `html2pdf.js`. Using one shared document builder keeps
   the two outputs in sync.
4. **Import** (`browser/docxImport`) is the same machinery in the other
   direction — `mammoth` again, this time reading a user's file — and **Save to
   Google Docs** uploads the very same `.docx`.

## What a printed lesson looks like

The exported lesson is laid out as a finished worksheet, not as an outline of the
editor:

- **A centred title block** on the first page — the title, then `By {author}`,
  then the lesson's age range and release month when it has them. All of it is
  derived from the lesson (`doc.ageRange`) and the record it was published from;
  nothing about any particular publisher is baked in, and a lesson with no author
  or publication date simply prints without those lines.
- **No section headings.** A section's name is an organising device for the
  editor; the printed lesson runs straight through from one block to the next.
- **Questions marked by colour alone** — the prompt in its type's colour,
  its answer in black on the same line, with no `[Label]` in front of it.
- **Spelling words on one running line**, `Spell: FIRST SECOND THIRD`.
- **A footer on every page**: the copyright line above a legend naming each
  question type in its own colour, which is what makes the colour coding legible.
- **A page number** in the top right corner.

`lessonTitleLines` and `lessonCopyright` in
`@spelling-creator/core/lessonLayout` decide the text of the title block and the
footer once, so the DOCX and the PDF print the same strings.

### Passing the by-line in

The author and publication date live on the lesson _record_, not in the document,
so both exporters take them as a second argument:

```js
await exportDocx(doc, { author: lesson.author, published: lesson.createdAt });
```

Omit it and the by-line and copyright line are left out; the editor passes the
signed-in user's display name, since a draft has no author of its own yet.

### Colour and alignment have to be smuggled past mammoth

mammoth drops run colours and paragraph alignment, so on the PDF path neither the
question colour coding nor the centred title lines survive on their own. The docx
therefore marks both with **named Word styles** — a character style per question
type and one paragraph style for the title lines — which `pdfExport` maps onto
CSS classes with a `styleMap` and colours again from `questions.js`.

That is also how **import** recovers a question's type now that nothing in the
visible text names it: `docxImport` asks mammoth for the same style map and reads
the type off the `<span class="s2c-q-…">`. Section _divisions_ have nothing left
to carry them, so a DOCX round trip collapses a lesson into a single section —
Export/Import **JSON** is the lossless one.

The page number and the footer are drawn straight onto the finished PDF pages
with jsPDF: they repeat on every page, so they cannot come from the flowed HTML,
and mammoth converts only the document body, never the docx's own header and
footer.

## Building a Word file is for Word files only

Those four are the whole list. Nothing else in the app touches `docx` or
`mammoth`; in particular, **preview does not**. The editor's preview mode
renders the lesson model directly with `LessonView` — the same component the
public `/hub/:id` page uses — so previewing builds no document, waits on no
chunk, and shows exactly what a reader will see. (It used to build a docx and
convert it back to HTML with mammoth just to fill a dialog.)

Keep it that way: a new "show me the lesson" surface should render `LessonView`,
not the export pipeline.

### On screen it follows the theme

`LessonView` draws a lesson in the app's own theme, light or dark, on both
surfaces that show one — the public lesson page and the editor's preview mode —
exactly as [interactive mode](./interactive-mode.md#what-it-looks-like) does.
It keeps the export's measurements (the `fitWithin` image maths against
`DOCX_MAX_IMAGE_WIDTH`, the spacing) and its block layout — no section headings,
a question's answer inline after its coloured prompt, spelling words on one line
— so a lesson keeps the shape it will print in; only the colours and the typeface
are the theme's. What it does _not_ copy is the paper furniture: the title
block's by-line, the page numbers and the footer legend belong to the printed
sheet, and the app already shows the author and the legend in its own chrome.

There is no second "paper" rendering to keep in sync. A lesson is read on screen
far more often than it is printed, and a white sheet glaring out of a dark page
is the wrong default for reading — the printout look lives in the thing that
actually prints, the DOCX and PDF exports.

Question-type and spelling colours stay literal there, as they are in the editor
and in interactive mode: they're content — the same colour coding the docx
carries — rather than chrome.

## It loads on demand

Together those libraries — `docx`, `mammoth`, `html2pdf.js`, `html2canvas`,
`jszip` — are the largest single cluster in the dependency graph: about 390 kB
gzipped. None of it is needed until someone clicks Export, Print, Import or Save
to Drive, so it lives in its own chunk behind `src/lib/exports/load.js`, in the
same shape as the git engine:

```js
const { exportDocx } = await loadExportEngine();
await exportDocx(doc);
```

`src/lib/exports/engine.js` is the chunk; nothing imports it directly. It's one
chunk rather than four because the entry points share nearly all their weight —
the PDF path builds the docx and converts it with mammoth, which is also what
the importer uses.

### The constants trap

`DOCX_MAX_IMAGE_WIDTH` lives in `@spelling-creator/core/lessonLayout`, **not**
beside the code that first needed it. It used to sit in `browser/docxExport`,
which meant `LessonView.jsx` — wanting one number, and rendering on the public
`/hub/:id` page — pulled the entire Word toolchain into the bundle every visitor
downloaded.

Being outside `browser/` is also what lets the server render a lesson at all:
that tier needs a DOM and is unreachable from the Worker by design, and
`/hub/:id` is [server-rendered](./server-rendering.md).

If you add a shared constant to any of these modules, put it in `lessonLayout`
and re-export it, rather than importing the module for the constant's sake.
