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
- **Search images** - find free Pixabay images from within a section and insert
  one with a click (see below).
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
- **Lesson hub** - browse lessons other users have published, preview any of them,
  and publish your own once signed in (see below).
- **Accounts** - passwordless magic-link sign-in (Supabase Auth) on a dedicated
  login page; required only to publish to the hub (see below).
- **Auto-save** - your work is kept in `localStorage` between reloads.

## Pages & routing

The app is a single-page app with three client-side routes (hash-based, so deep
links work on any static host without server rewrites):

| Route     | Page         | What it does                                                       |
| --------- | ------------ | ------------------------------------------------------------------ |
| `/`       | **Editor**   | The lesson builder (the original app). "Publish to hub" lives here. |
| `/#/hub`  | **Lesson hub** | Public gallery of published lessons; click one to preview it.     |
| `/#/login`| **Sign in**  | Magic-link sign-in / account status.                                |

Every page's header carries a shared nav (a **Lesson hub** link and an account
control that shows **Sign in** or the signed-in account menu). Routing is set up
in `src/main.jsx` (`HashRouter` + `AuthProvider`) and the route table is in
`src/App.jsx`.

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

## Search images

Press **Search images** on any section to open a dialog that searches
[Pixabay](https://pixabay.com) for free images and inserts the one you pick as
an image block. Like the AI features, it goes through the companion
`spelling-creator-cf` Worker rather than calling Pixabay directly, which:

- keeps the Pixabay API key server-side (it is never shipped to the browser),
- lets the Worker enforce Pixabay's **100 requests/minute** limit centrally, and
- works around Pixabay's image CDN sending no CORS headers — the browser can't
  read an image's bytes itself, so the Worker downloads the chosen image and
  returns it as a data URL that drops straight into the DOCX/PDF export.

The flow:

1. Type a search term; a [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/)
   token (the same widget as the AI dialogs) is sent with the request.
2. The Worker verifies the token, calls the Pixabay API with `mode:
   "imageSearch"`, and returns normalised hits (preview/webformat URLs, size,
   tags). It edge-caches the Pixabay response for 24 hours, which both satisfies
   Pixabay's caching requirement and keeps request counts well under the limit.
3. Click a result; the app calls the Worker again with `mode: "imageFetch"`,
   which downloads that image and returns it as a data URL.
4. The image is inserted as a new image block, with its caption pre-filled with
   attribution (`Image by {photographer} from Pixabay`) — editable like any other.

Each Worker call consumes its single-use Turnstile token, so the widget is reset
to mint a fresh one between searching and inserting. This feature needs the same
`VITE_API_URL` / `VITE_TURNSTILE_SITE_KEY` as the AI features, plus a
`PIXABAY_API_KEY` secret **on the Worker** (`wrangler secret put PIXABAY_API_KEY`).

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

## Lesson hub & accounts

The **Lesson hub** (`/#/hub`) is a public gallery of lessons users have shared.
Anyone can browse and preview; publishing requires a signed-in account.

**Where the data lives.** Lessons are stored in **Supabase Postgres**, but — like
the AI and Pixabay features — the browser never talks to the database directly.
All lesson reads/writes go through the companion `spelling-creator-cf` Worker,
which holds the privileged Supabase credentials server-side. The only thing the
browser does directly with Supabase is **authentication**.

**How sign-in works.** The login page (`/#/login`) uses
[Supabase Auth](https://supabase.com/docs/guides/auth) magic links: enter an
email, receive a one-time link, and the Supabase JS client (in `src/lib/supabase.js`)
exchanges the callback for a session. We use the **PKCE** flow so the callback
returns a `?code=` in the query string rather than tokens in the URL hash, which
avoids colliding with the hash-based router. The session JWT is what authorises a
publish: the app sends it to the Worker as a `Bearer` token, and the Worker
verifies it (and derives the author) before inserting the row.

```
 Browser ──magic link / session (Supabase JS)──▶ Supabase Auth
 Browser ──GET /lessons, GET /lessons/:id───────▶ Worker ──▶ Supabase Postgres   (public reads)
 Browser ──POST /lessons  (Bearer JWT)──────────▶ Worker ──verify JWT──▶ Postgres (publish)
```

### Worker endpoints (contract)

These live in the separate `spelling-creator-cf` repo. The frontend
(`src/lib/lessons.js`) expects them at paths under `VITE_API_URL`:

| Method & path        | Auth                | Response                                                                 |
| -------------------- | ------------------- | ------------------------------------------------------------------------ |
| `GET /lessons`       | none (public)       | `{ "lessons": [{ id, title, author, sectionCount, createdAt }] }` (newest first) |
| `GET /lessons/:id`   | none (public)       | `{ "lesson": { id, title, author, createdAt, doc } }`                    |
| `POST /lessons`      | `Bearer <Supabase JWT>` | `{ "lesson": { id, title, author, createdAt } }`                     |

- `doc` is the editor document shape used throughout the app:
  `{ title, sections: [{ id, name, blocks: [...] }] }`. Store it as `jsonb`.
- `POST /lessons` body is `{ title, doc }`. The Worker should **verify the JWT**
  (e.g. validate the HS256 signature with the Supabase JWT secret, or call
  `GET {SUPABASE_URL}/auth/v1/user` with the token), reject if invalid, take the
  author from the verified user (never trust a client-supplied author), and
  insert with the service-role key.
- On 4xx/5xx, return a short **plain-text** reason — the frontend surfaces it
  directly (matching the existing AI/Pixabay error convention).

### Supabase schema

The canonical, ready-to-run schema lives in the Worker repo at
`spelling-creator-cf/schema.sql`; this is the same thing for reference:

```sql
create table public.lessons (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references auth.users (id) on delete cascade,
  author        text,                       -- display name / email, denormalised for listing
  title         text not null,
  doc           jsonb not null,             -- the editor document { title, sections }
  -- Maintained by Postgres so the public listing can return a section count
  -- without the Worker downloading every (image-laden) doc.
  section_count int generated always as (jsonb_array_length(doc -> 'sections')) stored,
  created_at    timestamptz not null default now()
);

create index lessons_created_at_idx on public.lessons (created_at desc);

-- The Worker connects with the service-role key, which bypasses RLS. RLS is
-- still worth enabling as defence-in-depth in case the anon key is ever used:
alter table public.lessons enable row level security;
create policy "lessons are public to read"
  on public.lessons for select using (true);
-- (No insert policy for anon/auth roles: only the service-role Worker writes.)
```

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
VITE_API_URL=https://your-worker.example.workers.dev   # spelling-creator-cf endpoint (AI, Pixabay, lesson hub)
VITE_TURNSTILE_SITE_KEY=0x...                           # Cloudflare Turnstile site key
VITE_GOOGLE_CLIENT_ID=...apps.googleusercontent.com     # OAuth client for Save to Google Docs
VITE_SUPABASE_URL=https://xxxx.supabase.co              # Supabase project URL (magic-link sign-in)
VITE_SUPABASE_ANON_KEY=eyJ...                           # Supabase anon (public) key
```

The app degrades gracefully when a feature is unconfigured:

- Without `VITE_API_URL` / `VITE_TURNSTILE_SITE_KEY` the **AI text** dialog is
  disabled, and without `VITE_API_URL` the **Lesson hub** shows a "not
  configured" notice.
- Without `VITE_GOOGLE_CLIENT_ID` the **Save to Google Docs** button is hidden.
- Without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` sign-in is disabled
  (the login page explains this) and the **Publish to hub** button is hidden;
  browsing the hub still works.

The Supabase **anon key** is designed to be shipped to the browser. Keep the
**service-role key** and **JWT secret** on the Worker only — never in `VITE_*`
vars, which are bundled into the client.

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
  App.jsx                 route table (editor / hub / login)
  main.jsx                React entry point: HashRouter + AuthProvider + theme
  theme.js                MUI theme
  pages/
    EditorPage.jsx        the lesson builder (toolbar, section list, + button, publish)
    HubPage.jsx           public gallery of published lessons + preview dialog
    LoginPage.jsx         magic-link sign-in / account status
  components/
    NavActions.jsx        shared header nav: hub link + account (sign in / out) menu
    SectionCard.jsx       a named section with its content blocks + add buttons
    ContentBlock.jsx      a single text, image, or question block
    AiTextDialog.jsx      Turnstile-verified "suggest text with AI" dialog
    AiQuestionDialog.jsx  Turnstile-verified "suggest a question with AI" dialog
    ImageSearchDialog.jsx Turnstile-verified "search Pixabay images" dialog
  lib/
    docxExport.js         build + download the .docx (text, images, questions)
    pdfExport.js          docx -> html (mammoth) -> pdf (html2pdf.js)
    htmlPreview.js        docx -> html (mammoth) for in-app preview / hub viewer
    questions.js          question type definitions, colours, block factories
    aiSuggest.js          calls the spelling-creator-cf Worker for text + questions
    pixabay.js            calls the spelling-creator-cf Worker to search + fetch images
    lessons.js            calls the Worker to list / fetch / publish hub lessons
    supabase.js           Supabase client (auth only) + supabaseEnabled flag
    auth.jsx              AuthProvider + useAuth (session, magic link, sign out)
    googleDrive.js        OAuth2 + upload the docx to Drive as a Google Doc
    turnstile.js          Cloudflare Turnstile loader + site key
    image.js              file reading, sizing, data-url helpers
    storage.js            localStorage auto-save
    id.js                 id generation
```
