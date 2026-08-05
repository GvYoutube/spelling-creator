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
