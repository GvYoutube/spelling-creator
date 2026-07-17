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
- `apps/api/.env` — Worker secrets (e.g. `GEMINI_API_KEY`).

Both are gitignored.
