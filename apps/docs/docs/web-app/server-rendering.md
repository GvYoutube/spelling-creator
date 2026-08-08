---
title: Server rendering
sidebar_position: 2.5
---

# Server rendering

Three routes are rendered on the Cloudflare Worker before the browser runs any
JavaScript, and then hydrated in place:

| Route        | Data the server fetches   | Rendered for |
| ------------ | ------------------------- | ------------ |
| `/hub`       | `fetchPublishedLessons()` | Everyone     |
| `/hub/:id`   | `fetchLesson(id)`         | Everyone     |
| `/users/:id` | `fetchUserProfile(id)`    | Everyone     |

Everything else — `/`, `/editor`, `/login`, `/oauth/authorize`, `/moderation` —
is served as the static SPA shell exactly as before.

## Why only these three

Because their primary content is a **public read**. The Supabase session lives
in `localStorage` behind PKCE and is invisible to a server, so the render is
always anonymous; the personalised parts of the page (the account menu, an
author's Edit/Delete controls, whether you follow a profile) fill in when the
client hydrates. No session ever has to move to a cookie, which is what keeps
this tractable.

`fetchLatestLessons` and `fetchUserActivity` can't be server-rendered at all —
they parse Atom with `DOMParser`, and live in `@spelling-creator/core/browser/feeds`.
Both are dashboard content, so hydrating them is correct.

## How it fits together

```text
apps/web/src/entry-server.jsx     the app, built for workerd (`pnpm build:ssr` -> dist-ssr/)
apps/web/src/lib/ssr.jsx          the client/server handoff (SsrProvider, useServerData)
apps/api/src/routes/ssr.js        the Worker route: match, fetch, render, splice
```

1. `handleFrontend` (`apps/api/src/routes/render.js`) asks `shouldServerRender`.
2. `serverRender` fetches the page's data — through the very same
   `@spelling-creator/core` modules the browser calls, so the two paths can't
   drift — and calls `render()` from the server bundle.
3. `render()` returns `{ head, body }`. React hoists `<title>`/`<meta>` to the
   front of its output when rendering a subtree rather than a whole document, so
   they're split off and spliced into the real `<head>`; a scraper won't read an
   `og:` tag it finds in the body.
4. The Worker injects the body into `<div id="root">` and serialises the data
   into `window.__SSR__`.
5. `src/main.jsx` reads that, and calls `hydrateRoot` instead of `createRoot`.

**Failure is always soft.** A failed data fetch, a render error, a missing
server bundle — each falls through to the static shell, which is what the app
served before any of this existed.

## Page metadata

`src/lib/seo.jsx` exports a `<DocumentMeta>` component, not a hook. React 19
hoists `<title>`, `<meta>` and `<link>` into `<head>` from anywhere in the tree,
so page metadata is ordinary JSX — which is exactly what makes it work under
SSR, where an effect that writes into `document.head` never runs.

JSON-LD is deliberately _not_ hoisted: React only hoists `<script>` when it's
`async`, which is meaningless for a non-executable type. `<JsonLd>` renders in
place, which search engines accept.

## Things that had to change to make it work

- **`index.html`'s site-wide social defaults are stripped** on a rendered page,
  before the page's own tags go in. Otherwise a scraper reading the _first_
  `og:title` would get the generic one.
- **The service worker must not answer these navigations.** `navigateFallback`
  would otherwise serve the precached shell and the Worker would never be asked
  — silently disabling SSR for exactly the returning visitors whose browsers
  have the shell cached. The three routes are in `WORKER_PATHS` in
  `apps/web/vite.config.js`; see [Installable app & offline use](./pwa-and-offline.md#navigation-fallback-and-the-paths-it-must-not-touch).
- **`ColorSchemeProvider` no longer reads `localStorage`/`matchMedia` during
  render.** The server can't, and a hydrating client has to render the same
  thing the server did — the theme toggle shows a sun or a moon, so this is
  markup, not just a CSS variable. The stored choice is adopted in a layout
  effect, after hydration but before paint. Page colours were already correct
  pre-paint via the inline script in `index.html`.
- **`RichText` sanitizes only in the browser.** DOMPurify needs a real DOM, so
  the rich-text branch renders nothing on the server and appears immediately
  after mount. Rendering the _unsanitized_ HTML server-side is not an
  alternative: React never re-checks `dangerouslySetInnerHTML` during
  hydration, so whatever the server wrote is what the reader keeps. A profile
  bio still reaches crawlers, as the page's meta description.
- **`src/main.jsx` and `src/entry-server.jsx` must stay structurally in step.**
  Anything that renders DOM has to appear in both, in the same order. Sonner's
  `<Toaster>` renders an empty `<section>` even with no toasts, so it's in both;
  `ServiceWorkerPrompt` renders `null` and is browser-only, so it isn't.

## What SSR replaced, and what it didn't

`apps/api/src/routes/render.js` used headless Chromium for two unrelated jobs:

- **`prerender()`** — an HTML snapshot for ~30 crawler user-agents. SSR replaces
  this for the three routes above. It's still the fallback for `/` (whose
  content is auth-gated, so an anonymous render is only ever the marketing
  splash) and for any SSR attempt that fails.
- **`ogImage()`** — live 1200×630 screenshots for link previews. **Unaffected.**
  SSR cannot take a screenshot, so the `browser` binding stays.

## Build order

The Worker imports a build artifact, so `apps/web` must be built before the
Worker is bundled:

```bash
pnpm build     # client -> apps/web/dist, server -> apps/web/dist-ssr
pnpm deploy    # runs the above first
```

`pnpm --filter @spelling-creator/api dev` builds the server bundle itself before
starting `wrangler dev`. The Worker test suite is unaffected: it runs against a
test-only entry (`apps/api/src/collab-room.test-worker.js`) that doesn't import
the route table.

## Local development

`pnpm dev:web` (the Vite dev server) does **not** server-render — there is no
Worker in front of it, so every route arrives as the plain SPA shell and mounts
with `createRoot`. To exercise SSR you need `pnpm dev:api`, which serves the
built assets through the real Worker.
