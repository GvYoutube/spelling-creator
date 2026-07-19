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
