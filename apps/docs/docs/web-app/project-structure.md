---
title: Project structure
---

# Project structure

```
src/
  App.jsx                 route table (editor / hub / lesson / profile / login / moderation); the editor, moderation, login and OAuth routes are lazy (see pages-and-routing.md)
  main.jsx                React entry: ColorSchemeProvider + BrowserRouter + SsrProvider + AuthProvider + DisplayNameGate + Toaster + ServiceWorkerPrompt; hydrates a server-rendered page, mounts a plain one
  entry-server.jsx        the same tree built for the Worker (see server-rendering.md) — kept structurally in step with main.jsx
  styles/globals.css      Tailwind v4 + shadcn/ui design tokens (light/dark palettes, glass-surface shadows/blur), plus the `mb-safe` utility (see mobile-layout.md)
  locales/en/*.json      one JSON file per i18next namespace (see internationalization.md)
  pages/
    EditorPage.jsx        the lesson builder (toolbar, section list, + button, publish, collaborate) — and the owner of which of this device's lessons is open
    HubPage.jsx           public gallery of published lessons + client-side search
    ProfilePage.jsx       a user's public profile: bio + their published lessons
    LoginPage.jsx         magic-link sign-in / account status
    ModerationPage.jsx    moderator/admin queue for reported content
    lesson/               one lesson (/hub/:id) and its tabs — see pages-and-routing.md
      LessonLayout.jsx    owns the fetch, the identity header and every whole-lesson action; tabs read it via useLesson()
      LessonTabs.jsx      the tab bar — NavLinks to real routes, not a Tabs widget
      LessonOverview.jsx  the document itself + the "About" rail (author, ages, fork lineage, print/Word/fork)
      LessonPractice.jsx  interactive mode, given a URL
      LessonDiscussion.jsx  comments + the star rating
      LessonProposals.jsx / LessonProposal.jsx  proposals from other people's forks; the detail view hands merging to the editor
      LessonHistory.jsx   the published commit timeline, read out of the lesson's packfile (lazy — it loads the git engine)
  components/
    layout/
      AppShell.jsx        the one layout route every page sits in: SidebarProvider + AppSidebar + the page. Takes no configuration — one sidebar, one width, one persisted state. Publishes @container/page
      AppSidebar.jsx      the app's navigation, the account/theme/notification cluster, and your own lessons
      PageBar.jsx         the slim sticky bar: sidebar toggle + breadcrumb + the page's own actions
      PageBody.jsx        the content column, in two documented widths (wide / reading). Exports PAGE_WIDTHS for the two things that need the width but can't be the column
      EditorShell.jsx     the editor's nested routes behind one lazy import; mounts no chrome of its own
    editor/
      SectionOutline.jsx  the editor's left-hand section list (52rem+ of page column) — jump to a section, collapse them all
    InstallAppButton.jsx  the "install app" button in the sidebar footer; renders nothing unless the app is installable (see pwa-and-offline.md)
    NotificationBell.jsx  sidebar bell that polls for and shows the user's notifications
    DisplayNameGate.jsx   makes a signed-in user pick a display name before using the app
    DisplayNameDialog.jsx pick / change your public display name
    BioDialog.jsx         edit your public profile bio (rich text)
    FirstLessonWizard.jsx dismissable step-by-step welcome guide for newcomers
    CommentsSection.jsx   lesson comments list + post/reply/edit boxes, incl. the 1–5 star rating input
    RichTextInput.jsx     the tiptap-based editor used for comments + bios (formatting and links; no media)
    RichTextToolbar.jsx   its shadcn ToggleGroup toolbar (bold/italic/underline/lists/link/etc.)
    RichText.jsx          renders a stored comment/bio: sanitized HTML, or plain text for pre-rich-text values
    LiveField.jsx          debounced LiveInput/LiveTextarea (commit ~200ms after typing pauses, hold off remote updates while focused)
    LessonView.jsx        read-only renderer for the lesson page and the editor's preview mode (blocks straight to React, lazy images, drawn in the app's theme)
    LessonSummary.jsx     on-device AI summary card on the lesson page (hidden unless the browser supports it)
    InteractiveLesson.jsx full-screen step-by-step walkthrough of a lesson, with a field per question and optional read-aloud (see interactive-mode.md)
    MyLessonAnswers.jsx   the reader's own saved answers on the lesson page — private to them, rendered for nobody else
    SectionCard.jsx       a named section with its content blocks + add buttons; measures the pointer against its own rows during a block drag, but the drag itself is owned by EditorPage (blocks can move between sections)
    ContentBlock.jsx      a single text, spelling, image, or question block; owns BLOCK_LAYOUT, the responsive content/controls split (see mobile-layout.md)
    IconActionButton.jsx  the icon + tooltip button behind every block/section control; the tooltip doubles as its aria-label
    AiTextDialog.jsx       Turnstile-verified "suggest text with AI" dialog
    AiQuestionDialog.jsx   Turnstile-verified "suggest a question with AI" dialog
    AiLessonIdeaDialog.jsx Turnstile-verified "suggest a whole lesson outline with AI" dialog
    ImageSearchDialog.jsx  Turnstile-verified "search Pixabay images" dialog
    CollaborateDialog.jsx  live-collaboration control panel (host/join, roster, trusted collaborators)
    CollabCursors.jsx      floating coloured carets showing collaborators' selections
    CollabChat.jsx         in-session chat: a floating corner panel on desktop, a bottom sheet on mobile
    HistoryDialog.jsx      the lesson's version timeline: what each commit changed, per block, + restore
    LessonsDialog.jsx      the lessons this device holds: switch, copy, rename, delete, start another (see local-lessons.md)
    VariationsDialog.jsx   a lesson's variations — the branches of its repository, as an author sees them (see lesson-variations.md)
    MergeDialog.jsx        settle a merge — a fork's original, or a pull request being reviewed (mine / theirs / keep both)
    ProposeChangesDialog.jsx  open a pull request against the lesson this fork came from (see pull-requests.md)
    PullRequestsSection.jsx   proposed changes on a lesson's page, with review/merge and close for whoever may
    ui/                    shadcn/ui primitives (Button, Dialog, DropdownMenu, Select, Tooltip, Sonner Toaster, etc.) — Radix underneath, styled from the tokens in styles/globals.css
    ui/textarea.jsx        Textarea, which grows to fit its text (see "Auto-growing text fields"); hence `resize-none`, and never a scrollbar
  lib/
    i18n.js                react-i18next setup: registers every namespace's resources, fallback/supported languages
    languages.js           LANGUAGES registry for a future language switcher (English only today)
    colorScheme.jsx        ColorSchemeProvider + useColorScheme (light/dark/system, persisted, applied as data-theme on <html>)
    useLiveField.js        shared debounce/commit buffering behind LiveField.jsx
    collab.js             useCollaboration hook (one WebSocket to the CollabRoom Durable Object; doc sync, cursors, chat)
    useSelectionBroadcast.js broadcasts the local editor selection to peers
    useDragAutoScroll.js  scrolls the page while a block drag hovers near a window edge (the browser only auto-scrolls a native drag while the pointer keeps moving)
    useScrollAnchor.js    keeps a section/block still on screen while the move buttons reorder it, plus scrollToElement/idSelector (see navigating-large-lessons.md)
    git/                  what has to stay in the app — the rest is in core (see below)
      engine.js, load.js  the git engine, behind one dynamic import (keeps ~185 KB off the main bundle)
    exports/
      engine.js, load.js  the docx/PDF/import pipeline, behind one dynamic import (keeps ~390 KB gzipped off every page that never exports; preview doesn't need it)
      useLessonGit.js     the editor's controller: setup, periodic commits, history, restore
    useImageSrc.js        resolves an image ref to a displayable src
    useSpeech.js          Web Speech API text-to-speech for interactive mode (capability probe, voice/pace preferences, Chromium's utterance-length and cancel quirks)
    auth.jsx              AuthProvider + useAuth (session, magic link, sign out)
    seo.jsx               <DocumentMeta> / <JsonLd> — React 19 hoists these into <head>, which is what makes them work under SSR
    ssr.jsx               the client/server handoff: SsrProvider, useServerData, useSiteOrigin
    pwa.jsx               registers the service worker; toasts when a new build is waiting
    useInstallPrompt.js   captures beforeinstallprompt (or detects iOS Safari) behind the install button
```

Outside `src/`, `public/icons/` holds the PWA icons and the two SVGs they're
rasterised from, and the `VitePWA` block in `vite.config.js` holds the manifest
and service-worker configuration — see
[Installable app & offline use](./pwa-and-offline.md).

## Auto-growing text fields

Every `Textarea` sizes itself to its content, so a lesson paragraph or a long
question prompt is read in full inside its content block rather than scrolled
through a two-line slot. `ui/textarea.jsx` measures it: on each `input`, on any
change to a controlled `value` (a lesson loading, a collaborator's edit, an AI
suggestion landing in a block), and — via a `ResizeObserver` on the field — on
any change to its _width_, since re-wrapping the text changes how tall it needs
to be. That last one also covers a field going from zero width to a real one,
which is how a block inside a collapsed section gets measured when the section
is opened.

This was `field-sizing: content` — a single CSS declaration that does the same
job. It's deliberately gone: where a browser doesn't honour it there is no
symptom to debug, only a field stuck at its min-height showing a scrollbar and
a resize grabber, which is the exact state it existed to prevent. Measuring in
JS behaves identically everywhere, so it's the only path rather than a fallback
behind a feature test. Two class names ride along with it: `resize-none` (a
hand-dragged height would be overwritten by the next keystroke) and
`overflow-hidden` (the field is always exactly as tall as its text, so there is
nothing to scroll).

## Focus rings

`globals.css` gives `:focus-visible` the app's own ring — 2px of `--ring`, offset
by 2px — in the base layer. shadcn's primitives are unaffected: they pair
`outline-none` with a `focus-visible:ring-*` of their own, and utilities beat
base. The rule is there for everything else, and the app has a lot of it: the
header's links and icon buttons, the editor's toolbar buttons, the star rating.
None of those had a focus style, so they fell through to the browser's default
ring, which Chrome draws as a dark outline banded with white — stray chrome
rather than part of the app, and on the indigo header bar the white band was
the only part of it you could see.

It's a base rule rather than a class each control opts into because the
controls that were missing it are exactly the ones nobody thought about; this
way a new hand-rolled button gets it without anyone remembering.

Two surfaces override the color, because `--ring` _is_ `--primary` and would
disappear into them:

- **HomePage's hero** — a fixed gradient that doesn't follow the theme, so its
  two call-to-action links carry `focus-visible:outline-white` themselves.

There used to be a second: `header :focus-visible` switched the ring to
`--primary-foreground`, because the app bar was a block of `--primary` and the
ordinary ring vanished into it. `PageBar` draws on the page background, so the
ordinary ring is correct again — and the override had become actively wrong, a
near-white ring on a light surface. It is gone.

## Shared lesson logic

The parts of the lesson model that don't depend on React live in
`packages/core` (`@spelling-creator/core`), so the Worker and the MCP server can
apply the same rules. Each module is its own subpath export.

**Runtime-neutral** — safe to import from the browser, Node or the Worker:

```
@spelling-creator/core/
  config                the seam the host app passes its configuration through
  questions             question type definitions, colours, block factories
  spelling              helpers for the explicit "spelling words" block
  ageRanges             the age ranges a lesson can be pitched at
  lessonSearch          fully client-side hub search (Fuse.js)
  lessonFile            the .json lesson-file envelope (shared with the importer + MCP)
  jsonImport            parse + validate a .json lesson file back into the lesson model
  image                 image sizing: selectable sizes, scale, fit-within
  lessonLayout          the presentation constant every lesson render shares (DOCX_MAX_IMAGE_WIDTH) — outside browser/ so the viewer and the server render can use it without pulling in docx + mammoth
  id                    id generation
  wikimedia             Commons action-API round-trip + attribution metadata
  lessons               list / fetch / publish hub lessons (+ the feed URL)
  comments              list / post / edit lesson comments
  users                 other users' public profiles, follows, activity
  profile               your own profile (display name, bio)
  notifications         the notification feed
  moderation            the moderation queue
  pixabay               search + fetch Pixabay images via the Worker
  aiSuggest             AI text / questions / lesson ideas via the Worker
  spellingWords         the aggregated published-lesson word list
  mcpOAuth              the MCP OAuth approval handshake
  imagesClient          upload a lesson's images to the Worker (R2) on publish
  git/remote            the /git/:lessonId endpoints (pack in R2)
  richText              rich-text policy: allow-list, link schemes, HTML→text
  ydoc                  the Yjs lesson document: Y.Doc <-> doc model, remote apply, reconcile
  git/doc               pure doc helpers: canonical JSON, manifest, block map (no git)
  git/ops               diff two docs into block operations; render commit messages (no git)
  git/merge             three-way merge by block id, field-level (no git)
  git/layout            document <-> git tree (lesson.json manifest + blocks/<blockId>.json)
  git/repo              commit, history, diff two commits, restore (bare repo, pure plumbing)
  git/pack              pack for upload; clone/fetch from a pack; find the merge base
```

**Browser tier** — framework-agnostic, but needs a DOM (IndexedDB, `<canvas>`,
`FileReader`, an `<a>` to download). Behind a separate subpath so the Worker and
the MCP server cannot reach it by accident:

```
@spelling-creator/core/browser/
  imageStore            the IndexedDB stores themselves: the lesson library, its documents, image blobs, editor flags
  imageRef              binary image-ref model (a block references its bytes)
  imageFile             read a File to bytes, measure it, opportunistically re-encode to WEBP
  storage               the lesson library: every lesson this device holds, which one is open, and the two migrations into it
  docxExport            build the .docx (text, images, questions)
  docxImport            best-effort import of a .docx back into the lesson model
  pdfExport             docx -> html (mammoth) -> pdf (html2pdf.js) — the only non-Word use of the Word pipeline
  jsonExport            download a lesson as .json (the envelope itself is in lessonFile)
  feeds                 read the hub / user Atom feeds (DOMParser)
  supabase              the Supabase browser client (auth only), built on first use
  turnstile             the Cloudflare Turnstile widget loader
  googleDrive           OAuth2 + upload the docx to Drive as a Google Doc
  sanitizeRichText      the render-time DOMPurify pass (policy comes from ../richText)
  commonsImages         search Wikimedia Commons + download an image (no key, no proxy)
  presence              per-collaborator colour + selection presence helpers
  summarizer            browser Summarizer API wrapper (on-device summaries; fails closed)
  git/fs                LightningFS — the IndexedDB filesystem the repos live on
  git/sync              fork (= clone the repo) and merge-with-original flows
```

`.oxlintrc.json` enforces the split: `packages/core` is linted against the
`worker` env, and only `src/browser/**` is opted into `browser`. A module outside
that directory that reaches for `document` fails the lint rather than breaking
inside the Worker.

### The config seam

Core modules must not read `import.meta.env` — it is bundler-specific, substituted
at build time, and absent in Node, in the Worker and under any other bundler. A
module that reads it at import time can only ever be used by the web app, which is
what previously pinned the whole image/export tier inside `apps/web`.

So the host passes its configuration in once, before anything uses it:

```js
// apps/web/src/main.jsx — the only place in the app that touches import.meta.env
configureCore({
  apiUrl: import.meta.env.VITE_API_URL,
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  turnstileSiteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
});
```

Readers resolve **lazily** (`apiUrl()`, not a captured constant), which matters:
ES imports are hoisted, so `configureCore` runs after every module in the graph has
already been evaluated. Anything capturing the value at import time would capture
`""`. `packages/core/src/config.test.js` pins that behaviour.

The same reasoning is why `browser/supabase` builds its client inside
`getSupabase()` rather than at module scope, memoising it so the SDK's session and
refresh timer exist exactly once. It is also why the old `supabaseEnabled`,
`googleDriveEnabled`, `lessonHubEnabled`, `notificationsEnabled`, `profilesEnabled`
and `gitRemoteEnabled` constants are gone: every one was computed at module scope,
so under a lazily-resolved config all of them would have read as `false`. They are
now `hasSupabase()`, `hasGoogleDrive()` and `hasApi()` — the last replacing four
names for one predicate.

### Why version history splits the way it does

`git/repo` and friends never open a filesystem themselves — they take one through
`repoCtx`, which is why they port unchanged. What stays in the web app is
`engine` and `load` (the dynamic-import boundary and the `Buffer` polyfill
browsers need) plus `useLessonGit`, the editor's own controller. `fs`
(LightningFS over IndexedDB) and `sync` sit in core's browser tier, and `remote`
is runtime-neutral now that it reads its base URL through
[the config seam](#the-config-seam) rather than `import.meta.env`.

That boundary is load-bearing for bundle size: isomorphic-git stays behind
`load.js`'s dynamic import, in its own ~181 KB async chunk, rather than in the
bundle every homepage visitor downloads.

`wikimedia` holds only the parts of the Commons integration that are genuinely
common to both clients — the endpoint, the query/unwrap call, and the
licence/author handling. The web app and the MCP server keep their own search and
download functions on top of it, because their result shapes, paging and error
wording are part of their respective contracts and are not interchangeable.

`image` and `jsonExport` still use the DOM (a `<canvas>` to downscale, an `<a>` to
trigger a download), so only the web app imports them for now — see the
[monorepo overview](../monorepo/overview.md) for how that tier is being split out.
