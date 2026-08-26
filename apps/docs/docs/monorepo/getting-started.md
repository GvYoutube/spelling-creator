---
title: Getting started
---

# Getting started

```bash
pnpm install            # install all workspace deps

pnpm dev:web            # run the frontend (Vite)
pnpm dev:api            # run the Worker locally (wrangler dev)
pnpm dev:docs           # run this documentation site (VitePress)

pnpm build              # build the frontend
pnpm build:docs         # build the docs into apps/web/dist/docs
pnpm deploy             # build both, then deploy the Worker (wrangler deploy)

pnpm fmt                # format everything (oxfmt)
pnpm lint               # check formatting, then lint (oxfmt --check + oxlint)
```

Each app keeps its own environment file:

- `apps/web/.env` — `VITE_*`-prefixed values exposed to client code by Vite at
  build time (see `apps/web/vite.config.js`).
- `apps/api/.env` — Worker secrets (e.g. `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GROQ_API_KEY` — the Worker tries each configured AI provider in order, skipping any without a
  key set). Cloudflare Workers AI needs no key — it's wired up via the `AI` binding in
  `wrangler.jsonc` instead, and serves as the no-external-dependency fallback if every other
  provider is unset or fails.

Both are gitignored.

## Documentation site

This site is [VitePress](https://vitepress.dev). Pages are plain Markdown under
`apps/docs/docs`, and the config is `apps/docs/docs/.vitepress/config.mts` — the
`.mts` extension matters, because `apps/docs/package.json` has no
`"type": "module"` and VitePress is ESM-only.

The dependency tracks the **2.0 alpha on purpose**: `vitepress@latest` is still
1.6.4 from August 2025, and it would drag in a second Vite major (5) alongside
the Vite 8 that `apps/web` builds on. The range is `^2.0.0-alpha.19`, so the
lockfile decides the exact version — today `2.0.0-alpha.19`, and a lockfile
refresh can move it to a later alpha or to 2.x once that ships. See
[Frontend migration](./frontend-migration.md) for the full reasoning.

- **The sidebar is explicit.** A new page does not appear until it is listed in
  `themeConfig.sidebar`. That order is also the order of the sections in
  `llms.txt`.
- **Links between pages are relative and keep their `.md` extension**
  (`./search-images.md`), which is what lets VitePress rewrite them and fail the
  build on a dead one.
- **`base` is `/docs/`** and the output goes to `apps/docs/doc_build`, which
  `pnpm build:docs` then copies into `apps/web/dist/docs`. Run it **after** the
  web build — Vite empties `apps/web/dist` each time, so a `pnpm build` after
  `pnpm build:docs` deletes the docs again. `pnpm deploy` and the deploy
  workflow both run the two in that order for you. `cleanUrls` is on, and
  Cloudflare's default `auto-trailing-slash` asset handling resolves
  `/docs/intro` to `intro.html`.
- **`llms.txt` and `llms-full.txt`** come from
  [`vitepress-plugin-llms`](https://github.com/okineadev/vitepress-plugin-llms),
  which also emits a Markdown twin of every page next to its HTML.
- **`/docs/sitemap.xml`** is VitePress's built-in sitemap, with `<lastmod>` taken
  from git. It is separate from the Worker's dynamic `/sitemap.xml` (which covers
  the app's own pages and every published lesson); `robots.txt` advertises both.

## Code quality

The repo uses the [Oxc](https://oxc.rs) toolchain — `oxfmt` for formatting and
`oxlint` for linting. They replaced Prettier and ESLint, so `eslint.config.js`,
`.prettierrc` and `.prettierignore` no longer exist.

- **`.oxfmtrc.json`** (root) — `printWidth` is pinned to `80` (Prettier's
  default, and what the existing code is wrapped to; oxfmt's own default is
  `100`), plus the ignore list that used to live in `.prettierignore`.
- **`apps/api/.oxfmtrc.json`** — the Worker keeps its own style (tabs, single
  quotes, 140 columns), previously `apps/api/.prettierrc`. Oxfmt discovers
  nested configs automatically, so running `pnpm fmt` from the root still
  applies it.
- **`.oxlintrc.json`** (root) — the `eslint` and `react` plugins with the
  `correctness` category as errors, mirroring the old flat config's
  `js/recommended` + `eslint-plugin-react` + `eslint-plugin-react-hooks` setup.
  Per-app `overrides` supply the right globals for each runtime: browser for
  `apps/web`, worker + Node (plus `WebSocketPair` and
  `WebSocketRequestResponsePair`, the Durable Objects' globals) for `apps/api`,
  and Node for `apps/mcp`. `packages/core` is
  linted against the `worker` env — the narrowest of the three — so that anything
  reaching for a browser-only global there fails the lint rather than breaking at
  runtime inside the Worker. The modules that legitimately need the DOM
  are grouped under `src/browser/`, which is the only path opted back into `browser`.

`eslint/no-undef` is enabled explicitly: it's part of ESLint's `js/recommended`
but not of oxlint's `correctness` category, and it's what makes those `globals`
and `env` blocks do anything.

Oxlint enables its `unicorn`, `oxc` and `typescript` plugins by default; the
config lists `plugins` explicitly to keep them off, so the rule set stays the one
this codebase was written against. Two rules the ESLint config switched off —
`react/prop-types` and `react-hooks/set-state-in-effect` — are not implemented by
oxlint, so there is nothing to disable.

`react-hooks/exhaustive-deps` is a warning, and `pnpm lint` does not pass
`--deny-warnings`, matching the previous ESLint behaviour of not failing CI on it.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on `main` after a
merge: install (with `--frozen-lockfile`), `pnpm lint`, `pnpm test`, then the web
and docs builds.

`apps/api`'s own suite runs **twice, in two runtimes**, because the API is meant
to run in two. The `workers` project runs everything inside workerd — the hosted
instance's runtime, and the only place the Durable Objects and the R2/KV adapters
can be exercised for real. The `node` project runs the portable subset under Node,
which is what a self-hosted instance runs on. Most files are in both, and that
overlap is the point: a module that behaves differently across the two is a
self-hosting bug, and the cheapest moment to find one is when it is introduced.

`pnpm test` is `pnpm -r test`, which runs each workspace's own suite —
`packages/core` and `apps/api` under vitest (the Worker's through
`@cloudflare/vitest-pool-workers`, so its sanitizer tests run against the real
runtime), and `apps/mcp` under `node --test`. `apps/docs` has no test script and
is skipped.

The build runs without the `VITE_*` secrets — they are injected only for the real
deploy, and a pull request from a fork could not read them anyway. It still
resolves every import and runs the full bundler, which is what catches a bad
module path or a broken chunk boundary.

`.github/workflows/deploy.yml` is separate and still triggers only on a push to
`main`. It lints and builds again before deploying, but by then the change has
already been merged — CI is what gates the merge.

## Dependency updates

`.github/dependabot.yml` runs Dependabot every Monday against two ecosystems:

- **npm** — a single root entry covers all workspace packages, since Dependabot
  resolves pnpm workspaces from the root `pnpm-lock.yaml`.
- **github-actions** — the actions used by `.github/workflows/`.

Minor and patch bumps are grouped (dev tooling, React, Radix UI, Cloudflare,
then everything else split by production/development) so a routine week lands as
a handful of PRs; majors open individually because they need review.

`@cfworker/json-schema`, `@modelcontextprotocol/client` and
`@modelcontextprotocol/server` are ignored — all three are patched via
`patchedDependencies` in `pnpm-workspace.yaml` (the latter two inline their own
copy of the first), so bumping any of them requires regenerating the matching
`patches/*.patch` by hand. See
[the note on the `agents` dependency](../mcp-server/remote-mode.md#a-note-on-the-agents-dependency)
for why the patches exist and how to verify a regenerated one.
