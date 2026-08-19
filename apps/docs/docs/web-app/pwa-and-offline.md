---
title: Installable app & offline use
---

# Installable app & offline use

The web app ships as a **progressive web app**: it can be installed to a phone's
Home Screen or a desktop dock, it opens in its own window with no browser
chrome, and the editor keeps working with no network at all.

Offline support is mostly something the app already had. Lessons live in
IndexedDB — every lesson this device holds, their images as binary blobs, and a
git repository per lesson behind version history (see
[Lessons on this device](./local-lessons.md),
[Version history](/monorepo/version-history) and
[Lesson images](/monorepo/lesson-images)). What was missing was the other half:
without a service worker the browser still has to fetch `index.html` and the JS
bundle over the network before any of that stored data can be reached. Precaching
the built shell closes that gap.

## What works offline, and what doesn't

| Works offline                                              | Needs the network                         |
| ---------------------------------------------------------- | ----------------------------------------- |
| Opening the app at any client-side route                   | The lesson hub, profiles, comments        |
| Switching between the lessons on this device               | Publishing a fork's changes as a proposal |
| Writing, editing, reordering, deleting sections and blocks | Publishing / saving to the cloud          |
| Images already in the local image store                    | Image search (Pixabay, Wikimedia)         |
| Version history: commits, browsing, restoring              | AI text / question / lesson-idea dialogs  |
| DOCX export and PDF printing                               | Live collaboration                        |
| Lesson images seen before (cached by hash)                 | Sign-in, Save to Google Docs              |

Everything in the right-hand column already degrades with a clear message when
the feature is unconfigured (see [Getting started](./getting-started.md)); with
no connection they fail the same way rather than being hidden.

## How it's put together

The service worker and the manifest come from
[`vite-plugin-pwa`](https://vite-pwa-org.netlify.app), configured in the
`VitePWA` block of `apps/web/vite.config.js`. It runs in `generateSW` mode, so
Workbox writes `dist/sw.js` from the build's own asset list — nothing has to be
kept in sync by hand.

### Precache

The precache is the built shell: `index.html`, the JS/CSS chunks, the
self-hosted Fontsource `.woff2` files, and the icons. Two things are
deliberately left out:

- **`public/home/*.jpg`**, the homepage's feature screenshots (~245 KB). Those
  are marketing images; they aren't worth an install-time download, so a runtime
  `StaleWhileRevalidate` rule picks them up the first time someone actually
  looks at the homepage.
- **`dist/docs/`**, this documentation site. `pnpm build:docs` copies the VitePress
  output in _after_ the web build, and it has its own hashed assets and its own
  pages — none of which belong in the app's precache.

`maximumFileSizeToCacheInBytes` is raised to 4 MiB because the `vendor` chunk is
over Workbox's 2 MiB default on its own.

### Navigation fallback, and the paths it must not touch

Client-side routes are answered from the precached `index.html`, which is what
makes a deep link like `/hub/abc123` work with no network. But the Cloudflare
Worker in front of the app answers plenty of paths itself — `run_worker_first`
means it sees every request before the static assets do — and the service worker
must not shadow those with the app shell.

`WORKER_PATHS` at the top of `apps/web/vite.config.js` is that list, passed to
Workbox as `navigateFallbackDenylist`: the [server-rendered routes](./server-rendering.md)
(`/hub`, `/hub/…`, `/users/…`), `/docs`, `/images/…`, `/git/…`, `/collab`,
`/og-image`, the MCP OAuth paths (`/authorize`, `/token`, `/register`, `/mcp`,
`/.well-known/…`), and the SEO endpoints (`sitemap.xml`, `robots.txt`,
`feed.xml`, `spelling-words.json`). Anything not on it is assumed to be a route
in `src/App.jsx`.

The server-rendered routes are on the list for a reason worth spelling out: if
the service worker answers `/hub/abc123` from the precached shell, the Worker is
never asked, and server rendering silently stops happening — for returning
visitors specifically, the only people whose browsers have the shell cached.
Nothing is lost offline, since all three need the network for their data anyway.

It's a **denylist rather than an allowlist** on purpose. Adding a page to
`App.jsx` shouldn't require a matching edit to the build config, and the failure
mode is the gentler one: an unlisted route falls through to the network, which
online still lands on `index.html` via the Worker's `single-page-application`
asset fallback. An over-broad allowlist, by contrast, would have the service
worker confidently answer `/docs/intro` with the React app.

### Runtime caching

| Rule                     | Handler                | Why                                                                                             |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `/images/<64-hex>`       | `CacheFirst`           | Lesson images are addressed by the SHA-256 of their bytes, so a URL's content can never change. |
| Other same-origin images | `StaleWhileRevalidate` | The homepage screenshots — worth keeping, not worth blocking on.                                |

The image rule is matched by a callback rather than a `RegExp`: `VITE_API_URL`
may point at a different origin, and Workbox only applies a `RegExp` route
cross-origin when it matches from the very start of the URL.

`cacheableResponse` accepts status `200` and **not** `0`. Status `0` is an
opaque response, which is what a cross-origin `<img>` the app didn't fetch
itself yields — but opaque means _no status at all_, so a 404 or a 502 looks
exactly like a hit. Under `CacheFirst` that error would then be served from
the cache for the full 30 days with no retry, so a single blip while an image
was still uploading would break it permanently. (Opaque entries are padded to
megabytes apiece for quota accounting too, and the rule allows 300 of them.)

The deployed app gives nothing up for this: the Worker serves both the SPA and
`/images` from the same origin, so the responses are `basic` and carry a real
status. A self-host that points `VITE_API_URL` at a different origin loses
offline images — the browser's own HTTP cache still applies — which is the
right way round from a cache that can poison itself.

Hub listings, profiles and comments are **not** cached. They're user-specific
and change often, and a stale hub is more confusing than an unavailable one.

## Updates

`registerType` is `"prompt"`, not `"autoUpdate"`. Activating a new service
worker reloads the page, and this is an editor — swapping the running build out
from under someone mid-lesson isn't something to do silently.

So `src/lib/pwa.jsx` registers the worker and raises a Sonner toast when a new
build is waiting: _"A new version is available"_, with a **Reload** action that
calls `updateServiceWorker(true)`. The toast has no timeout and can be
dismissed; dismissing lets it be offered again at the next check rather than
never again for the life of the tab. That check runs hourly, and only while
`navigator.onLine` — an installed PWA's window can stay open for days, and
without a poll it would only notice a deployment on a manual reload.

## Installing

`src/lib/useInstallPrompt.js` captures Chromium's `beforeinstallprompt` event
and calls `preventDefault()` on it, which suppresses the browser's own
mini-infobar and lets `InstallAppButton.jsx` put the affordance in the header
next to the other nav actions. The event fires before React mounts, so the
listener is registered at module scope and the captured event is held in a small
store that components read through `useSyncExternalStore`.

The button renders nothing at all unless the app is actually installable, so on
a desktop visit that doesn't qualify — or once the app _is_ installed, detected
via `(display-mode: standalone)` — the header is unchanged.

Safari has no equivalent event: on iOS an app is installed through Share → **Add
to Home Screen**, and there is no API to trigger it or even to ask whether it's
available. There the button is shown on browser sniffing instead, and opens a
dialog with the two steps. Chrome, Firefox and Edge on iOS are excluded — they
are Safari underneath, but their UI has no "Add to Home Screen" item, and
pointing someone at a menu entry they don't have is worse than saying nothing.

## The manifest and icons

The manifest is generated from the `manifest` block in `vite.config.js`;
`vite-plugin-pwa` injects the `<link rel="manifest">`. The tags it doesn't own
are written by hand in `apps/web/index.html`: `theme-color` (twice — a
`prefers-color-scheme: dark` variant first, since Safari takes the first match),
`mobile-web-app-capable`, `apple-mobile-web-app-title`, the status-bar style,
and `apple-touch-icon`. iOS ignores the manifest's icons and its `display` field
without those.

`theme_color` (`#4f5fd9`) and `background_color` (`#dee3f3`) are `--primary` and
`--background` from `src/styles/globals.css`, so the OS window chrome and the
launch splash are continuous with the app's own light theme.

Icons live in `apps/web/public/icons/`. `icon.svg` and `maskable.svg` are the
sources; the PNGs are rasterised from them.

- **`icon.svg` / `icon-192.png` / `icon-512.png`** — purpose `any`. Drawn as-is
  by the platform, so they carry their own rounded corners.
- **`maskable.svg` / `maskable-512.png`** — purpose `maskable`. A full-bleed
  square that Android crops to whatever shape the launcher uses, with the glyph
  at 45% so it stays inside the safe zone (the centre 80% circle).
- **`apple-touch-icon.png`** (180px) — full-bleed for the same reason; iOS
  applies its own rounding.

To regenerate the PNGs after editing an SVG, on macOS:

```bash
cd apps/web/public/icons
sips -s format png icon.svg --out icon-512.png
sips -s format png maskable.svg --out maskable-512.png
```

`sips` rasterises at the SVG's intrinsic size, so the 192px and 180px variants
need an SVG whose `width`/`height` say so — change those two attributes (the
`viewBox` stays) and convert again.

## Local development

`devOptions.enabled` is `false`, so **no service worker runs under `pnpm dev`**.
That keeps Vite's HMR behaving normally and avoids debugging a stale cache that
only exists on your machine. To exercise the PWA, build and preview:

```bash
pnpm build
pnpm preview
```

`localhost` counts as a secure context, so the worker registers there without
TLS. Chrome DevTools → **Application** → **Service Workers** / **Manifest** is
the fastest way to check registration, and its **Offline** checkbox to check the
fallback. Remember to **Unregister** (or tick _Update on reload_) between builds
— otherwise the previous worker keeps serving the previous bundle, which is
exactly what it's designed to do.
