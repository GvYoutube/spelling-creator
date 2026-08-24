---
title: Pages & routing
---

# Pages & routing

The app is a single-page app with real-path client-side routes (served by
`BrowserRouter`, not hash routes). Every page has a genuine URL like `/hub/:id`,
which is what lets the Worker recognise a route it can [render server-side](./server-rendering.md),
and it serves `index.html` for unknown paths so deep links resolve.

## One shell

The route table in `src/App.jsx` puts every page inside a single layout route,
`AppShell`, and that is the whole of the app's chrome: a collapsible sidebar
(`AppSidebar`) beside the page, with `PageBar` at the top of it.

Pages used to render their own `AppHeader` over their own `mx-auto max-w-*`
column, which is why they all looked alike and why anything larger than a column
— a merge, a collaboration session, a commit timeline — had nowhere to go but a
modal. The chrome now lives in the layout route, and a page describes only its
own body.

The sidebar takes no per-page configuration. It is 16rem wide everywhere,
collapses to a 3rem icon rail everywhere (`collapsible="icon"` — collapsing
leaves navigation you can still reach rather than removing it), and its state is
one persisted preference that follows you between pages. An earlier version let
routes configure it, and the editor used that to pin itself to a permanent rail;
the result was an app with two sidebars of different widths, one of which threw
away the state you had set on every other page.

Pages that need more room ask the **container**, not the shell — see
[Laying out against the container](#laying-out-against-the-container).

There is exactly one route outside the shell, and it is deliberate rather than
left over:

- `/oauth/authorize` — the MCP consent screen, reached by redirect from a
  third-party client (`apps/api/src/routes/oauth.js`). App navigation on a grant
  screen is an invitation to wander off in the middle of one.

`/` is inside it like everything else, both signed in (a dashboard) and signed
out (the marketing splash). The splash briefly had a header of its own, on the
grounds that a first-time visitor doesn't need navigation; that was a defensible
thing to say about the splash and the wrong thing to do to the app, because it
meant one URL rendered two different chromes depending on who you were.

## The content column

`components/layout/PageBody.jsx` is the column every page renders into, and it
exists for the same reason `AppShell` does: "the content column" had drifted
into five different things across the pages, at three different top paddings and
three different bottom ones, none of which meant anything.

There are two widths:

| Width            | Value       | For                                                                                                                                           |
| ---------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `wide` (default) | `max-w-5xl` | Listings, dashboards, the lesson and its side rail. Also what fits beside the expanded sidebar at 1280px without the page scrolling sideways. |
| `reading`        | `max-w-3xl` | Prose people read or write: comments, a proposal's description, a commit list.                                                                |

The `reading` width is why the page getting wider did **not** make lesson text
wider: a line of text set to the full width of a desktop screen is harder to
read, not easier. The two things that need the column's width but can't be the
column — the lesson's sticky tab bar and a Suspense fallback — import
`PAGE_WIDTHS` rather than restating the number.

Two places opt out and say so where they do: the marketing hero (a full-bleed
gradient) and the editor's panes.

## Laying out against the container

`SidebarInset` — the page column — is a named container (`@container/page`), and
anything that lays itself out against available space keys off that rather than
off a `lg:`/`xl:` viewport breakpoint.

This matters because the sidebar is 16rem open and 3rem collapsed, so how much
room a page has is not a function of the window's width. The editor's outline
pane appears once the page column passes 52rem; the lesson's "About" rail moves
alongside the lesson at the same 52rem. Collapse the sidebar and the threshold
is crossed immediately, with no change to the window:

| Window | Sidebar | Page column | Outline |
| ------ | ------- | ----------- | ------- |
| 1440px | open    | 1184px      | yes     |
| 1280px | open    | 1024px      | yes     |
| 1024px | open    | 768px       | no      |
| 1024px | rail    | 976px       | **yes** |

That is what lets one sidebar configuration serve the editor as well as every
other page. Viewport breakpoints could not: at 1024px they have no way to know
whether 256px of the screen is currently a sidebar or not — the last two rows
are the same window, and only one of them has room for an outline.

## The routes

| Route                      | Page                    | What it does                                                                                                                                                                                          |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                        | **Home**                | Landing page. Signed out: a marketing splash (animated floating words + feature blurbs). Signed in: a dashboard (latest-lessons feed, your activity, activity from people you follow, notifications). |
| `/editor`                  | **Editor**              | The lesson builder. Two panes — section outline and document — the outline appearing once the page column has room for it. **Preview** toggles the document pane for the reader's view of the lesson. |
| `/editor/lessons`          | **Editor**              | The [lessons this device holds](./local-lessons.md), over the editor — switch between them, copy, rename or delete one.                                                                               |
| `/editor/history`          | **Editor**              | The version-history panel, over the editor.                                                                                                                                                           |
| `/editor/variations`       | **Editor**              | The [variations](./lesson-variations.md) panel, over the editor.                                                                                                                                      |
| `/editor/collaborate`      | **Editor**              | The [live-collaboration](./live-collaboration.md) panel, over the editor.                                                                                                                             |
| `/hub`                     | **Lesson hub**          | Public gallery of published lessons (plus your own drafts), with search.                                                                                                                              |
| `/hub/:id`                 | **Lesson → Lesson**     | The lesson itself, with an "About" rail: author, ages, section count, fork lineage, and the print / Word / fork actions.                                                                              |
| `/hub/:id/practice`        | **Lesson → Practice**   | [Interactive mode](./interactive-mode.md), full screen over the page.                                                                                                                                 |
| `/hub/:id/discussion`      | **Lesson → Discussion** | Comments and the star rating.                                                                                                                                                                         |
| `/hub/:id/proposals`       | **Lesson → Proposals**  | [Changes proposed](./pull-requests.md) from other people's forks.                                                                                                                                     |
| `/hub/:id/proposals/:prId` | **Lesson → Proposals**  | One proposal, read-only. **Review & merge** hands off to the editor — see below.                                                                                                                      |
| `/hub/:id/history`         | **Lesson → History**    | The lesson's published commit timeline, read out of its packfile.                                                                                                                                     |
| `/users/:id`               | **User profile**        | A user's public profile — bio, follower/following counts, a Follow button, and published lessons.                                                                                                     |
| `/login`                   | **Sign in**             | Magic-link sign-in / account status.                                                                                                                                                                  |
| `/moderation`              | **Moderation**          | Moderator/admin queue for reviewing reported content (gated to mods/admins).                                                                                                                          |

Unknown paths redirect to the home page (`/`). An unknown `/editor/<something>`
does not: the editor treats a panel name it doesn't recognise as "no panel
open", so a stale link shows the editor rather than bouncing you out of it.

`EditorShell` mounts no chrome — `AppShell` is already above it — and exists
only to hold the chunk boundary and the editor's own nested routes.

### A lesson's tabs

`src/pages/lesson/` holds one file per tab plus `LessonLayout.jsx`, which owns
the fetch, the identity header (title, author, rating) and every action on the
lesson as a whole. Tabs read the lesson through `useLesson()` — the layout's
outlet context — and never fetch it again.

They are real routes rather than a `<Tabs>` widget because that is what makes
them shareable, back-button-correct and [server-renderable](./server-rendering.md).

Two things deliberately did **not** become tabs:

- **Merging a proposal.** It is a genuine three-way merge against the lesson's
  git history, and that history lives in the editor's browser-side repository.
  `/hub/:id/proposals/:prId` is read-only and its **Review & merge** button
  navigates to `/editor?pull=<id>&lesson=<lessonId>`, exactly as the old stacked
  list did. See [Proposed changes](./pull-requests.md).
- **The editor's own history panel.** It reads _your_ repository, the one your
  edits are committed to. The lesson page's History tab is a different thing
  built on the published packfile (`GET /git/:lessonId/pack`); it loads the git
  engine on demand, so isomorphic-git stays out of the bundle a reader
  downloads.

## Query-string deep links

Four query strings deep-link into the editor rather than being routes of their
own:

| Link                           | What it does                                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?join=<code>`                 | Opens the [live-collaboration](./live-collaboration.md) panel on that invite.                                                                                                                                                                 |
| `?pull=<id>&lesson=<lessonId>` | Opens a [proposed change](./pull-requests.md) for review once the lesson it names has loaded — the lesson id is part of the link precisely so the review waits for the right one, rather than acting on whatever the editor already had open. |
| `?local=<id>`                  | Switches to one of the [lessons on this device](./local-lessons.md).                                                                                                                                                                          |
| `?new=1`                       | Starts a new lesson — what the sidebar's **New lesson** button links to, since plain `/editor` resumes whichever lesson you last had open.                                                                                                    |

The first two are consumed once and then simply sit in the URL; the last two are
stripped from it as they are read, because they are instructions rather than
state and a reload should not carry them out twice. Opening an editor panel
preserves the query string, so navigating to `/editor/collaborate` never drops
the invite that sent you there.

## Offline and the service worker

Once the PWA service worker is installed it resolves these routes itself, from
the precached `index.html`, which is what lets a deep link open with no network.
The paths the Worker answers instead — the server-rendered routes, `/docs`,
`/images/…`, the SEO and MCP OAuth endpoints — are excluded by name; see
[Installable app & offline use](./pwa-and-offline.md#navigation-fallback-and-the-paths-it-must-not-touch).

That exclusion covers the whole of `/hub/*`, lesson tabs included, so those
paths **must** stay matched by the server renderer. A path excluded from the
shell and unmatched by the Worker works online (it falls through to the SPA
shell) and fails offline. `WORKER_PATHS` in `apps/web/vite.config.js` and
`LESSON_PATH` in `apps/api/src/routes/ssr.js` have to agree; both carry a
comment saying so.

Routing is set up in `src/main.jsx` (`BrowserRouter` + `SsrProvider` +
`AuthProvider`, wrapped in a `DisplayNameGate`) and the route table is in
`src/App.jsx`.

## Which routes are lazy

`src/App.jsx` splits the route table deliberately rather than lazy-loading
everything:

- **Eager** — `/`, `/hub`, `/users/:id`, and `/hub/:id` with all its tabs except
  History. The server-rendered routes have to be in the bundle the client
  hydrates with; deferring them would trade a smaller download for a round trip
  on the pages where first paint matters most. `/` is the commonest entry point.
- **Lazy** — `/hub/:id/history`, `/editor`, `/moderation`, `/login`,
  `/oauth/authorize`. History is lazy because it is the only reader-facing page
  that needs isomorphic-git and LightningFS (~200 KB). The editor matters most:
  ~6,000 lines, and the only owner of Yjs, `lib0` and the collaboration client,
  none of which a reader of a lesson should download. `EditorShell` is lazy for
  that reason too — importing it eagerly from `App.jsx` would pull the editor
  straight back into the main bundle.

`AppShell` mounts a `Suspense` boundary of its own around its `<Outlet/>`. The
one in `App.jsx` sits _above_ the layout routes, so a lazy page suspending there
unwinds past the shell and takes the sidebar with it — and any fallback that
used `PageBar` would then throw, having lost the `SidebarProvider` too. The
inner boundary keeps the chrome on screen and replaces only the body.

Tiptap/ProseMirror stays eager on purpose — `CommentsSection` uses
`RichTextInput` on the public lesson page, so it isn't editor-only.

## Home page

The home page (`src/pages/HomePage.jsx`) has two faces, chosen from the auth
state. Both render inside the app's shell, with the same sidebar and page bar
as everywhere else — only the body differs:

- **Signed out** — a hero whose backdrop is real spelling words drifting upward
  (built with [tsParticles](https://particles.js.org); see
  `src/components/FloatingWords.jsx`), followed by alternating feature blurbs.
  The words come from the Worker's `GET /spelling-words.json` — an aggregate of
  every spelling word taught across the published hub lessons, rebuilt at most
  once every two days and cached in KV (`apps/api/src/routes/spelling-words.js`).
  A spelling row can hold a phrase rather than a single word ("ice cream"), and
  those animate badly — the shape scales text by character count, so a phrase
  renders tiny and stretched — so `@spelling-creator/core/spellingWords` drops any entry
  containing whitespace and only single words reach the animation.
  If that fetch fails, a small built-in word list is used instead. Feature
  illustrations live under `apps/web/public/home/` (a missing file degrades to a
  labelled placeholder — see that folder's `README.md`).
- **Signed in** — a dashboard showing the hub's latest-lessons Atom feed and the
  user's own activity feed (both parsed client-side from Atom with `DOMParser`,
  reusing the same `feed.xml` / `profiles/:id/feed.xml` endpoints the "RSS"
  links point at), a **"From people you follow"** feed (from the Worker's
  `GET /following/activity`; see [Following](./profiles-and-display-names.md#following)),
  plus a roomier list of the user's notifications.
