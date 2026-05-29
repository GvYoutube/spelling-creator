# Spelling Lesson Maker

A web app for building and printing [**Spelling**](https://i-asc.org) (also known as S2C) lessons.
Create a document, add named sections, and fill each section with text and
images. Export the finished lesson as a Word document (`.docx`) or print it to
PDF.

Built with **React + Vite + MUI**, using [`docx`](https://docx.js.org) for Word
export and [`html2pdf.js`](https://github.com/eKoopmans/html2pdf.js) (via
[`mammoth`](https://github.com/mwilliamson/mammoth.js) docx→HTML conversion) for
PDF printing.

## Features

- **Document title** - name the whole lesson.
- **Add sections** with the floating **+** button; each new section is named in a dialog.
- **Text and image blocks** inside any section. Add, caption, reorder, or delete them.
- **Question blocks** - add structured questions in five types (see below).
- **AI text suggestions** - generate a block of lesson text from a section's
  title with one click (see below).
- **AI question suggestions** - generate a structured question of any type from
  a section's title and existing text (see below).
- **Reorder / delete** sections and blocks with inline controls.
- **Export DOCX** - downloads a formatted `.docx`.
- **Print PDF** - builds the docx, converts it to HTML with mammoth, then renders
  a PDF with html2pdf.js so the printout mirrors the Word document.
- **Save to Google Docs** - signs in with Google (OAuth2) and uploads the docx to
  the user's Drive, converting it to a native Google Doc (see below).
- **Auto-save** - your work is kept in `localStorage` between reloads.

## Question blocks

Each section can hold **question blocks** alongside text and images. Pick a type
from the **Add question** menu; every type is colour-coded so it's easy to scan
the lesson at a glance. The types, their shape, and their colours live in one
place, `src/lib/questions.js`, so the editor and both exporters stay in sync.

| Type                     | Colour | What it captures                                                          |
| ------------------------ | ------ | ------------------------------------------------------------------------- |
| **Number answer**        | purple | A single numeric answer.                                                  |
| **Single answer**        | green  | A list of options with exactly one correct choice.                        |
| **Multiple answers**     | orange | A list of options with any number of correct choices.                     |
| **Open ended**           | pink   | A free written response with a configurable number of blank answer lines. |
| **Background knowledge** | blue   | A prompt plus the prior knowledge a student needs to answer it.           |

Questions are rendered into the DOCX (and therefore the printed PDF) with their
prompt, options, answer markers, and blank lines, so the exported lesson is ready
to print and use.

## AI text suggestions

Press **AI text** on any section to open a dialog that generates a block of
lesson text about that section's title. The flow:

1. The section title is used as the subject — there's no separate prompt to fill in.
2. A [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) widget
   verifies the request is coming from a real browser on our domain.
3. The verified token, subject, and document title are POSTed to a companion
   Cloudflare Worker (`spelling-creator-cf`), which re-checks the token
   server-side before doing any AI work and returns the generated text.
4. The text is inserted as a new text block in the section, ready to edit.

This feature requires two environment variables (see **Getting started**). The
Worker itself lives in a separate repository; this app only talks to its endpoint.

## AI question suggestions

Press **AI question** on any section to open a dialog that suggests a structured
question block. It uses the same Turnstile-verified Worker as the text
suggester, just in a different mode. The flow:

1. Pick a question type (the same five types as the **Add question** menu).
2. The section title is used as the subject; the section's existing text is sent
   as context so the question is answerable from the lesson.
3. Turnstile verifies the request, then the verified token, subject, type, and
   context are POSTed to the Worker with `mode: "question"`.
4. The Worker asks the model for JSON matching that question type (prompt,
   options, answer, etc.) and returns it.
5. The suggestion is inserted as a new, fully editable question block of that
   type, with option indexes mapped back onto option ids in
   `src/lib/questions.js`.

## Save to Google Docs

Press **Save to Google Docs** in the toolbar to upload the current lesson straight
to the signed-in user's Google Drive as an editable Google Doc. The flow is
entirely client-side:

1. [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/overview)
   issues a short-lived OAuth2 access token, prompting the user to sign in and
   consent the first time.
2. The app builds the same docx as **Export DOCX**, then uploads it to the Drive
   `files` endpoint as `multipart/related`, asking Drive to store it as
   `application/vnd.google-apps.document` so it is converted to a Google Doc.
3. On success a toast offers an **Open** link to the new doc.

The app requests only the [`drive.file`](https://developers.google.com/drive/api/guides/api-specific-auth)
scope, so it can touch only the files it creates — never the user's existing
Drive contents. The button is hidden unless `VITE_GOOGLE_CLIENT_ID` is set (see
**Environment variables**). The OAuth client must list every origin the app is
served from (e.g. `http://localhost:5173` and the production URL) under
**Authorised JavaScript origins**, and the Google Drive API must be enabled for
the project.

## Getting started

```bash
pnpm install
pnpm dev      # start the dev server (http://localhost:5173)
pnpm build    # production build into dist/
pnpm preview  # preview the production build
```

### Environment variables

The AI text feature needs two variables in a `.env` file at the project root
(Vite exposes `VITE_`-prefixed vars to the client):

```bash
VITE_API_URL=https://your-worker.example.workers.dev   # spelling-creator-cf endpoint
VITE_TURNSTILE_SITE_KEY=0x...                           # Cloudflare Turnstile site key
VITE_GOOGLE_CLIENT_ID=...apps.googleusercontent.com     # OAuth client for Save to Google Docs
```

Without `VITE_API_URL` / `VITE_TURNSTILE_SITE_KEY` the rest of the app works
fine; only the **AI text** dialog is disabled (it surfaces a configuration
error). Without `VITE_GOOGLE_CLIENT_ID` the **Save to Google Docs** button is
hidden.

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
  main.jsx                React entry point
  theme.js                MUI theme
  components/
    SectionCard.jsx       a named section with its content blocks + add buttons
    ContentBlock.jsx      a single text, image, or question block
    AiTextDialog.jsx      Turnstile-verified "suggest text with AI" dialog
    AiQuestionDialog.jsx  Turnstile-verified "suggest a question with AI" dialog
  lib/
    docxExport.js         build + download the .docx (text, images, questions)
    pdfExport.js          docx -> html (mammoth) -> pdf (html2pdf.js)
    questions.js          question type definitions, colours, block factories
    aiSuggest.js          calls the spelling-creator-cf Worker for text + questions
    googleDrive.js        OAuth2 + upload the docx to Drive as a Google Doc
    turnstile.js          Cloudflare Turnstile loader + site key
    image.js              file reading, sizing, data-url helpers
    storage.js            localStorage auto-save
    id.js                 id generation
```
