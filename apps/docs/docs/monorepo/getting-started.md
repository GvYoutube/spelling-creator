---
title: Getting started
sidebar_position: 2
---

# Getting started

```bash
pnpm install            # install all workspace deps

pnpm dev:web            # run the frontend (Rsbuild)
pnpm dev:api            # run the Worker locally (wrangler dev)

pnpm build              # build the frontend
pnpm deploy             # deploy the Worker (wrangler deploy)

pnpm fmt                # format everything (oxfmt)
pnpm lint               # check formatting, then lint (oxfmt --check + oxlint)
```

Each app keeps its own environment file:

- `apps/web/.env` — `VITE_*`-prefixed values consumed by Rsbuild at build time
  (the app deliberately kept the `VITE_` prefix — see `apps/web/rsbuild.config.mjs`).
- `apps/api/.env` — Worker secrets (e.g. `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GROQ_API_KEY` — the Worker tries each configured AI provider in order, skipping any without a
  key set). Cloudflare Workers AI needs no key — it's wired up via the `AI` binding in
  `wrangler.jsonc` instead, and serves as the no-external-dependency fallback if every other
  provider is unset or fails.

Both are gitignored.

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
  `apps/web`, worker + Node (plus `WebSocketPair`, `WebSocketRequestResponsePair`
  and `HTMLRewriter`) for `apps/api`, and Node for `apps/mcp`. `packages/core` is
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

`.github/workflows/ci.yml` runs on every pull request and on `master` after a
merge: install (with `--frozen-lockfile`), `pnpm lint`, `pnpm test`, then the web
and docs builds.

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
`master`. It lints and builds again before deploying, but by then the change has
already been merged — CI is what gates the merge.

## Dependency updates

`.github/dependabot.yml` runs Dependabot every Monday against two ecosystems:

- **npm** — a single root entry covers all workspace packages, since Dependabot
  resolves pnpm workspaces from the root `pnpm-lock.yaml`.
- **github-actions** — the actions used by `.github/workflows/`.

Minor and patch bumps are grouped (dev tooling, React, Radix UI, Cloudflare,
then everything else split by production/development) so a routine week lands as
a handful of PRs; majors open individually because they need review.

`@cfworker/json-schema` is ignored — it's patched via `patchedDependencies` in
`pnpm-workspace.yaml`, so bumping it requires regenerating
`patches/@cfworker__json-schema@<version>.patch` by hand.
