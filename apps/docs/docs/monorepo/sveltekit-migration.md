---
title: SvelteKit migration
sidebar_position: 5
---

# SvelteKit migration

A plan, not a commitment. Phase 1 is done and was worth doing on its own terms;
everything after it is only worth doing if the SSR win and a UI redesign are both
real. Nothing so far forecloses either choice.

## Why this is a view-layer rewrite, not a product rewrite

The reason to consider a framework change at all is that a redesign was already
planned. Changing frameworks without one is pure cost; changing during one is
marginal cost. That only holds if the code that _isn't_ the view layer can come
along unchanged — which is what phase 1 established.

| Area                          | Lines               | Fate                             |
| ----------------------------- | ------------------- | -------------------------------- |
| `packages/core`               | ~7,500 (+635 tests) | Ports untouched                  |
| `apps/web/src/lib`            | ~1,900              | React hooks and contexts → runes |
| `apps/web` pages + components | ~13,000             | Rewritten                        |

So the rewrite surface is roughly **14,600 lines of UI**, against ~8,100 lines of
lesson logic that already runs in the browser, in Node and inside the Worker.

## What "one package" does and doesn't mean

A common expectation of SvelteKit is that it unifies client and server into one
package. That unification has already happened here, and it is `packages/core` —
the same modules the browser calls are callable from a server render, which is
exactly what the phase 1 config seam bought.

SvelteKit adds **server-rendering of the UI**. It should not absorb `apps/api`:

- `apps/api` owns the `CollabRoom` **Durable Object**, which is a Workers
  primitive SvelteKit does not model.
- It hosts the **MCP server** (`@spelling-creator/mcp`), consumed by AI
  assistants rather than browsers, behind its own OAuth provider.
- It holds the R2, KV, Workers AI and Browser Rendering bindings.

Folding those into a web framework would mean every UI deploy redeploys the
collaboration runtime and the MCP OAuth provider. The SvelteKit server layer
should stay thin: `+page.server.js` load functions that call `packages/core`,
nothing more.

## Phase 1 — decouple from the bundler (done)

Eighteen modules read `import.meta.env` at module scope, which is Rsbuild-specific
and absent in Node, in the Worker, and under any other bundler. They now read
through `@spelling-creator/core/config`, and `apps/web/src/main.jsx` is the only
place in the app that touches `import.meta.env`.

Reads resolve **lazily**. ES imports are hoisted, so `configureCore` runs after
every module in the graph has been evaluated; anything capturing a value at import
time would capture `""`. Six exported flags (`supabaseEnabled`, `googleDriveEnabled`,
`lessonHubEnabled`, `notificationsEnabled`, `profilesEnabled`, `gitRemoteEnabled`)
were exactly that mistake waiting to happen, and are now `hasSupabase()`,
`hasGoogleDrive()` and `hasApi()`.

## Phase 2 — the SSR boundary

| Route                                                  | Primary data                            | SSR                    |
| ------------------------------------------------------ | --------------------------------------- | ---------------------- |
| `/hub/:id`                                             | `fetchLesson(id)` — public JSON         | Yes, fully             |
| `/hub`                                                 | `fetchPublishedLessons()` — public JSON | Yes; drafts hydrate    |
| `/users/:id`                                           | `fetchUserProfile(id)` — public JSON    | Yes; activity hydrates |
| `/`                                                    | all fetches auth-gated or DOMParser     | Shell only             |
| `/editor`, `/login`, `/oauth/authorize`, `/moderation` | IndexedDB, Yjs, auth                    | No                     |

Every route worth server-rendering is a **public read**, which is the point that
keeps this tractable: the server renders anonymously and the personalised parts
(the account menu, edit affordances, drafts) hydrate on the client. The Supabase
session lives in `localStorage` under the PKCE flow and is invisible to a server —
migrating it to cookies via `@supabase/ssr` is a separate, optional project, and
**not** a prerequisite.

Two functions cannot be server-rendered at all: `fetchLatestLessons` and
`fetchUserActivity` parse Atom with `DOMParser` and live in
`@spelling-creator/core/browser/feeds`. Both are dashboard/menu content rather
than primary content, so hydrating them is correct. If that ever changes, the
Worker already generates those feeds and could serve JSON beside them.

### What SSR replaces, and what it doesn't

`apps/api/src/routes/render.js` uses Browser Rendering for **two** unrelated jobs:

- **`prerender()`** — a headless-Chromium HTML snapshot for ~30 crawler
  user-agents. SSR genuinely replaces this. It, `shouldPrerender()` and the
  `CRAWLER_UA` regex all go, as does `apps/web/src/lib/seo.js` (the
  `useDocumentMeta` hook across 7 pages), replaced by `<svelte:head>` per route.
- **`ogImage()`** — live 1200×630 screenshots for link previews. **SSR does not
  replace this.** Removing it is a feature loss unless something takes its place.

The intended replacement is [Satori](https://github.com/vercel/satori) — it
generates an SVG from a layout description, which `@resvg/resvg-wasm` rasterises
to PNG. Both are pure JS/WASM and run in a Worker, so the `browser` binding, the
`@cloudflare/puppeteer` dependency and the `nodejs_compat` flag it requires can
all go.

Two consequences worth accepting deliberately: Satori cannot use system fonts, so
the faces must be embedded as assets; and previews become a **designed card**
rather than a screenshot of the page. For a lesson that is probably an improvement,
but it is a visual change, not a like-for-like swap.

## Phase 3 — the parallel app

`apps/web-svelte` alongside `apps/web`, migrating one route at a time. Both import
`@spelling-creator/core`. Order is value-first, difficulty-last:

1. `/users/:id` — smallest, read-only, proves the pipeline
2. `/hub` and `/hub/:id` — the SEO payoff; **retire the prerender once these land**
3. `/` — carries the tsparticles swap
4. `/login`, `/oauth/authorize`
5. `/moderation`
6. `/editor` — see phase 4

The `ui/` layer (22 shadcn components) gets rebuilt on shadcn-svelte during step 1
and amortises across everything after.

### Routing during coexistence

`apps/api` should stay the front door — it owns the Durable Object and the MCP
provider. Two ways to put SvelteKit behind it:

- **Workers Routes (recommended).** Deploy the SvelteKit Worker on specific route
  patterns (`/users/*`, then `/hub/*`, …) plus `/_app/*` for its assets;
  `apps/api` keeps `/*`. Cloudflare picks the most specific route, so migrating a
  route is a config change and rolling back is the same. Asset prefixes don't
  collide — SvelteKit emits `/_app/*`, Rsbuild emits `/static/*`.
- **Service binding.** More centralised, but it is unverified whether a
  service-bound Worker's own static assets resolve correctly. **Settle this with a
  deploy before committing to it.**

## Phase 4 — the editor

Its own project, and by far the largest: `EditorPage` (2,165 lines), `SectionCard`
(671), `ContentBlock` (608), `collab` (660) and `useLessonGit` (328).

This is also where Svelte pays back. `collab.js` is largely "subscribe to a Y.Doc,
force a re-render" plumbing, and runes map onto Yjs observers directly, so that
code should shrink rather than translate. The same is true of `useLiveField` and
`useSelectionBroadcast`.

## Package targets

Verified against the registry when this was written; re-check before starting.

| Package                        | Version    | Note                                         |
| ------------------------------ | ---------- | -------------------------------------------- |
| `svelte`                       | 5.56.8     | runes                                        |
| `@sveltejs/kit`                | 2.70.2     |                                              |
| `@sveltejs/adapter-cloudflare` | 7.2.9      | **not** the deprecated `-cloudflare-workers` |
| `vite`                         | 8.2.0      |                                              |
| `bits-ui`                      | 2.18.1     | shadcn-svelte's foundation                   |
| `yjs`                          | 13.6.32    | app is on 13.6.31                            |
| `@tiptap/core`                 | **3.29.2** | app is on **2.27.2** — a major bump          |

That tiptap gap matters: the editor migration would be v2→v3 **and** React→Svelte
at once. Better known now than discovered in phase 4.

### Dependency swaps

| Now                      | Then                      | Risk                                               |
| ------------------------ | ------------------------- | -------------------------------------------------- |
| `react-router-dom`       | SvelteKit routing         | None — pages are being rewritten anyway            |
| `radix-ui` + shadcn      | shadcn-svelte (`bits-ui`) | Check `field`, `spinner`, `star-rating` first      |
| `@tiptap/react`          | `@tiptap/core` on a div   | Low — easier in Svelte, no reconciler to fight     |
| `react-i18next`          | Paraglide                 | Low, and an upgrade. 14 namespace JSONs to convert |
| `@tsparticles/react`     | `@tsparticles/svelte`     | Low                                                |
| `sonner`                 | `svelte-sonner`           | Low                                                |
| `lucide-react`           | `lucide-svelte`           | None                                               |
| `react-compiler-runtime` | (deleted)                 | Runes make it unnecessary                          |

## What the spike proved

A throwaway `apps/web-svelte` on the versions above, with one route:

```js
// src/hooks.server.js
configureCore({ apiUrl: PUBLIC_API_URL });

// src/routes/users/[id]/+page.server.js
import { fetchUserProfile } from "@spelling-creator/core/users";
export async function load({ params }) {
  const { user, lessons } = await fetchUserProfile(params.id);
  return { user, lessons };
}
```

Against a stub API, the server response contained `<h1>Ada Lovelace</h1>`,
`42 followers`, the lesson list, and `<title>` / `og:title` from
`<svelte:head>` — with no JavaScript executed, which is precisely what the
puppeteer prerender exists to produce today.

Two things this confirmed beyond the happy path:

- `fetchUserProfile` is **the same module the React app calls from the browser**.
  No server-specific client, no duplicated fetch logic. That is what phase 1 was
  for.
- **No browser-tier module leaked into the server bundle.** The
  `@spelling-creator/core/browser/*` split holds under a real SSR build, not just
  under the lint rule.

`adapter-cloudflare` builds and emits `_worker.js`, `_app/`, `_routes.json` and
`_headers`. Deploying that as a Worker means pointing wrangler's
`assets.directory` at `.svelte-kit/cloudflare` and `main` at its `_worker.js`.

## What could still go wrong

- **Two bundles, no shared chunks.** During coexistence you ship React _and_
  Svelte, and `/hub` visitors pay for it. Temporary, but real.
- **No control group.** Changing design and framework together makes a regression
  un-attributable. Keep the React build deployable and per-route switchable for
  longer than feels necessary.
- **The editor may have no clean seam.** Everything above it is a page portable in
  isolation; `/editor` is one large component entangled with collab and git. If it
  stalls, coexistence lasts a long time — survivable, but plan for it rather than
  discovering it.
- **Agent tooling is React-shaped.** The `shadcn` skill, `AGENTS.md` and ~25 docs
  pages all assume shadcn-React.
