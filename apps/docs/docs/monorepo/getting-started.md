---
title: Getting started
sidebar_position: 2
---

# Getting started

```bash
pnpm install            # install all workspace deps

pnpm dev:web            # run the frontend (Vite)
pnpm dev:api            # run the Worker locally (wrangler dev)

pnpm build              # build the frontend
pnpm deploy             # deploy the Worker (wrangler deploy)
```

Each app keeps its own environment file:

- `apps/web/.env` — `VITE_*` values consumed by Vite at build time.
- `apps/api/.env` — Worker secrets (e.g. `GEMINI_API_KEY`).

Both are gitignored.
