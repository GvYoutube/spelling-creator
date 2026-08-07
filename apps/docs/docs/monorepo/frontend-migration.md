---
title: Frontend migration
sidebar_position: 5
---

# Frontend migration

A decision record, not a commitment. The enabling work is done and was worth
doing on its own terms; the framework choice is still open.

## What phase 1 established

Eighteen modules read `import.meta.env` at module scope — bundler-specific, and
absent in Node, in the Worker, and under any other bundler. They now read through
`@spelling-creator/core/config`, and `apps/web/src/main.jsx` is the only place in
the app that touches `import.meta.env`.

Reads resolve **lazily**. ES imports are hoisted, so `configureCore` runs after
every module in the graph has been evaluated; anything capturing a value at import
time would capture `""`. Six exported flags (`supabaseEnabled`,
`googleDriveEnabled`, `lessonHubEnabled`, `notificationsEnabled`,
`profilesEnabled`, `gitRemoteEnabled`) were exactly that mistake waiting to
happen, and are now `hasSupabase()`, `hasGoogleDrive()` and `hasApi()`.

The result:

| Area                          | Lines               | Fate under any migration |
| ----------------------------- | ------------------- | ------------------------ |
| `packages/core`               | ~7,500 (+635 tests) | Ports untouched          |
| `apps/web/src/lib`            | ~1,900              | React hooks and contexts |
| `apps/web` pages + components | ~13,000             | Rewritten                |

So the surface is roughly **14,600 lines of view layer**, against ~8,100 lines of
lesson logic that already runs in the browser, in Node and inside the Worker.

**This is the part that was worth doing regardless.** It also surfaced three
drifted copy-paste duplications (`wikimedia`, `richText`, the Atom feed parser),
a lockfile that had never installed what its manifest claimed, and a repository
running zero tests in CI.

## The "one package" question

A common expectation is that a meta-framework unifies client and server into one
package. That unification already happened here, and it is `packages/core` — the
same modules the browser calls are callable from a server render.

Whatever is chosen should **not** absorb `apps/api`. It owns the `CollabRoom`
Durable Object, hosts the MCP server behind its own OAuth provider, and holds the
R2, KV, Workers AI and Browser Rendering bindings. Folding those into a web
framework would mean every UI deploy redeploys the collaboration runtime.

## The SSR question (independent of framework)

| Route                                                  | Primary data                            | SSR                    |
| ------------------------------------------------------ | --------------------------------------- | ---------------------- |
| `/hub/:id`                                             | `fetchLesson(id)` — public JSON         | Yes, fully             |
| `/hub`                                                 | `fetchPublishedLessons()` — public JSON | Yes; drafts hydrate    |
| `/users/:id`                                           | `fetchUserProfile(id)` — public JSON    | Yes; activity hydrates |
| `/`                                                    | all fetches auth-gated or DOMParser     | Shell only             |
| `/editor`, `/login`, `/oauth/authorize`, `/moderation` | IndexedDB, Yjs, auth                    | No                     |

Every route worth server-rendering is a **public read**. The server renders
anonymously and the personalised parts hydrate on the client, so the Supabase
session — `localStorage`, PKCE, invisible to a server — never needs migrating to
cookies. That is what keeps SSR tractable here.

`fetchLatestLessons` and `fetchUserActivity` cannot be server-rendered at all:
they parse Atom with `DOMParser` and live in
`@spelling-creator/core/browser/feeds`. Both are dashboard/menu content, so
hydrating them is correct.

### What SSR replaces, and what it doesn't

`apps/api/src/routes/render.js` uses Browser Rendering for **two** unrelated jobs:

- **`prerender()`** — a headless-Chromium HTML snapshot for ~30 crawler
  user-agents. SSR genuinely replaces this, along with `shouldPrerender()`, the
  `CRAWLER_UA` regex, and `apps/web/src/lib/seo.js` (226 lines across 7 pages).
- **`ogImage()`** — live 1200×630 screenshots for link previews. **SSR does not
  replace this.** Deleting it is a feature loss.

The intended replacement is [Satori](https://github.com/vercel/satori), which
generates an SVG that `@resvg/resvg-wasm` rasterises to PNG. Both are pure
JS/WASM and run in a Worker, so the `browser` binding, `@cloudflare/puppeteer`
and the `nodejs_compat` flag can all go. Two consequences to accept
deliberately: Satori cannot use system fonts, so Fraunces and Public Sans must be
embedded as assets; and previews become a **designed card** rather than a
screenshot. Probably an improvement for a lesson, but a visual change.

## Options considered

### A — SvelteKit

Mature meta-framework, `adapter-cloudflare` targets Workers-with-assets directly.
Costs: the whole view layer is rewritten into a different template language, and
`.svelte` files are not meaningfully supported by oxfmt/oxlint — likely
reintroducing `prettier-plugin-svelte` and `eslint-plugin-svelte`, partially
undoing the oxc migration.

### B — Solid + SolidStart

Keeps JSX, but SolidStart is the weak link: **104K weekly downloads against
SvelteKit's 2.5M**, on precisely the layer being adopted. Kobalte, the component
foundation, is still 0.13.x.

### C — Solid without a meta-framework

Keeps JSX and the current SPA-served-by-the-Worker architecture. No SSR, so the
prerender stays — though `solid-js/web` exports `renderToStringAsync`, and
hand-rolling SSR for four read-only routes in the existing Worker is bounded work
that can come later.

### D — Stay on React, add SSR

The cheapest route to the only clear architectural win. React 19 SSR on the
Worker already running. Forgoes the reactivity improvement entirely.

### Comparison

|                  | View-layer cost | SSR                   | Toolchain      | Ecosystem risk |
| ---------------- | --------------- | --------------------- | -------------- | -------------- |
| A SvelteKit      | Full rewrite    | Excellent             | oxc regression | Low            |
| B SolidStart     | Conversion      | Unproven here         | oxc kept       | High           |
| C Solid, no meta | Conversion      | None (later, by hand) | oxc kept       | Medium         |
| D React + SSR    | None            | Hand-rolled           | Unchanged      | None           |

## What the spikes showed

### SvelteKit

A throwaway app on Svelte 5.56.8 / Kit 2.70.2 / adapter-cloudflare 7.2.9, with
one route whose `+page.server.js` imported `@spelling-creator/core/users`
directly. Against a stub API the server response carried the profile name,
follower count, lesson list and the `<svelte:head>` title and `og:title`, with no
JavaScript executed — exactly what the prerender produces today.

Two things it confirmed beyond the happy path: `fetchUserProfile` is **the same
module the React app calls from the browser**, with no server-specific client;
and **no browser-tier module leaked into the server bundle**, so the
`core/browser/*` split holds under a real SSR build and not only under the lint
rule.

### Solid — a negative result worth recording

`@rsbuild/plugin-solid` 1.2.2 **did not transform JSX** under
`@rsbuild/core` 2.1.10, in either a shared config or a dedicated one. Output was
React's JSX runtime in both cases (`React.createElement`, plus React Compiler
memoisation artifacts in the shared config), and `rsbuild inspect` showed **no
babel loader in the resolved Rspack config** — the plugin is silently a no-op.
Scoping `pluginReact` with `exclude` did not hand the file over. Peer ranges are
compatible, so this looks like a v1-era plugin against the v2 plugin API rather
than a hard incompatibility, but it was not resolved.

`vite` 8.2.0 with `vite-plugin-solid` 2.11.14 compiled the identical source
correctly — Solid's `template`/`insert` output with getter-based props.

**Consequence, since acted on:** a Solid app needs Vite today, not Rsbuild — so
`apps/web` was moved to Vite 8 on its own, still on React, before any framework
decision. See [Build tooling](#build-tooling) below. That removes the "second
build tool" cost from options B and C: a Solid app would now be a second entry
under the same bundler, and `.jsx` stays `.jsx`, so oxfmt/oxlint are preserved
either way.

## Build tooling

`apps/web` runs on **Vite 8** (`apps/web/vite.config.js`). This was done on its
own, still on React, so that changing the build tool and changing the framework
are separately attributable — the control group the risk list below asks for.

Why, beyond unblocking B and C: Vite 8 is Rolldown and Lightning CSS, which is
Oxc underneath, so the bundler now shares an engine with oxlint, oxfmt and
Vitest. Before this, the repo ran Rspack/SWC for building and Rolldown/Oxc for
everything else, and `node_modules` carried both.

What the move cost, measured against the Rsbuild build it replaced:

|                   | Rsbuild  | Vite 8   |
| ----------------- | -------- | -------- |
| JS, gzipped total | 1,048 kB | 1,044 kB |
| App chunk         | 401 kB   | 400 kB   |
| Lazy git engine   | 186 kB   | 197 kB   |
| Build time        | —        | ~2s      |

Notes on the config, all of which are load-bearing:

- **`VITE_*` env vars need no config** — Vite substitutes `import.meta.env`
  natively, so Rsbuild's `loadEnv`/`publicVars` shim is gone. The prefix that
  had been kept for continuity is now simply correct.
- **The React Compiler runs as a Babel pass** (`@rolldown/plugin-babel` +
  `reactCompilerPreset({ target: "18" })`), not through SWC. `target: "18"` is
  required: it emits imports from `react-compiler-runtime` rather than React
  19's `react/compiler-runtime`, which React 18 does not export.
- **`codeSplitting.groups` is not optional.** Rolldown puts everything reachable
  from the entry in one chunk, where Rsbuild split vendors by default; without
  the groups, editing one app file invalidates ~3.4 MB for returning visitors.
  Both groups are tagged `$initial` so they capture only the statically-reachable
  graph — untagged, the vendor group also swallows isomorphic-git and the
  tsparticles shapes, which are supposed to stay behind a dynamic import.
- **No `build.target` override.** Vite 8's `baseline-widely-available` default
  (chrome111, edge111, firefox114, safari16.4) is wider than the
  `["defaults", "not IE 11"]` browserslist this app used to compile against,
  which now resolves to a floor of chrome 109, edge 146, firefox 140,
  safari 26.3. Chrome 109–110 is the only coverage given up.

`apps/docs` is still Rspress, so Rspack has not left the tree. Moving it would
mean a different site generator and reworking every page — deliberately out of
scope.

### Vite+ — evaluated, deferred

Vite+ (`vite-plus`, MIT, beta) bundles Vite, Vitest, Oxlint, Oxfmt, Rolldown and
a caching monorepo task runner behind one `vp` CLI. It was considered at the same
time and deferred, for reasons that are about sequencing rather than merit:

- It ships its own `oxlint` and `oxfmt` binaries, which are **LSP-only wrappers
  that exit 1** when invoked as linters. They lose the `.bin` slot to this repo's
  direct `oxlint`/`oxfmt` devDependencies, so installing it alongside them is
  harmless — but adopting it means removing those, and `pnpm lint` is
  `oxfmt --check . && oxlint`.
- Its docs explicitly do not recommend `.oxlintrc.json` or `.oxfmtrc.json`;
  config belongs in `lint`/`fmt` blocks in `vite.config.ts`. This repo's
  `.oxlintrc.json` is 95 lines of per-package overrides, including the one
  enforcing the `core/browser/*` boundary, and override semantics differ.
- `vp migrate` aliases `vite` to Vite+ core through a workspace-root pnpm
  override and removes `vitest` as a direct dependency. `apps/api` runs
  `@cloudflare/vitest-pool-workers`, which peers on a specific Vitest.
- 0.2.8 pins `oxlint =1.76.0` and `oxfmt =0.61.0`; this repo is ahead of both.

Its own prerequisite is Vite 8 + Vitest 4.1, which this move satisfies. Revisit
at 1.0, on a branch, by running `vp migrate --no-interactive` and reading the
diff.

## If option C is chosen — the plan

Conversion surface, measured:

| Site                                    | Count |
| --------------------------------------- | ----- |
| `.jsx` files (37 app + 22 shadcn `ui/`) | 59    |
| `useState` → `createSignal`             | 189   |
| `.map()` → `<For>`                      | 70    |
| Destructured props → `props.x`          | 107   |
| `useEffect` → `createEffect`/`onMount`  | 51    |
| `useMemo`/`useCallback`                 | 40    |
| `useRef`                                | 26    |
| react-router call sites                 | 44    |

No `createPortal`, no `cloneElement`, only 6 context sites. The 58 `forwardRef`
wrappers all live in `ui/` and **disappear** — in Solid `ref` is an ordinary prop.

1. **Foundation** (~2,000 lines). Vite + `vite-plugin-solid`, `@solidjs/router`,
   port `ui/` onto Kobalte, plus the three contexts. Nothing user-visible ships.
   This is the gate: Kobalte is 0.13.x and everything sits on it. Check `field`,
   `spinner` and `star-rating` first.
2. **Leaf components** (~1,200). `LessonView`, `RichText`, `RichTextInput`,
   `LiveField`, `Skeletons`, `AppHeader`, `NavActions`.
3. **Read-only routes** (~2,300). `ProfilePage`, `HubPage`, `LessonPage`,
   `CommentsSection`, `LessonSummary` — the SSR-worthy set.
4. **The rest** (~1,900). `ModerationPage`, `HomePage`, `OAuthAuthorizePage`,
   `LoginPage`, and the remaining dialogs.
5. **The editor** (~6,000), its own project. `EditorPage`, `SectionCard`,
   `ContentBlock`, the collab dialogs, plus `collab.js` and `useLessonGit`.

Two design calls to make before phase 5 rather than during:

- **Keep the lesson document in a plain signal with whole-value replacement.**
  Version history recovers intent by diffing successive whole documents
  (`diffDocs` in `git/ops.js`). A fine-grained `createStore` is the idiomatic
  Solid move and would quietly complicate that.
- **Spend fine-grained reactivity on fields, not the document** — `LiveField`,
  presence, cursors, per-block rendering. That is where React costs the most
  today.

### The failure mode to build a habit around

Destructuring a prop in Solid does not error. It silently stops updating. There
is no warning and no crash — only a component that mysteriously fails to react.
With 107 sites to convert, treat "no destructured props" as a review rule from
day one, not a cleanup task.

## Risks common to A, B and C

- **Two bundles during coexistence.** Both runtimes ship until the last route
  moves.
- **No control group.** Changing design and framework together makes a regression
  un-attributable. Keep the React build deployable and per-route switchable
  longer than feels necessary.
- **The editor may have no clean seam.** Everything above it is a route portable
  in isolation; `/editor` is one large component entangled with collab and git.
  If it stalls, coexistence lasts a long time.
- **Agent tooling is React-shaped.** The `shadcn` skill, `AGENTS.md` and ~25 docs
  pages all assume shadcn-React.
