# Spelling Creator (monorepo)

A pnpm monorepo containing the Spelling Lesson Maker web app and its Cloudflare
Worker API.

## Packages

| Path       | Package                  | Description                                                        |
| ---------- | ------------------------ | ------------------------------------------------------------------ |
| `apps/web` | `@spelling-creator/web`  | Vite + React frontend (MUI, Supabase, react-router). Deploys to GitHub Pages. |
| `apps/api` | `@spelling-creator/api`  | Cloudflare Worker backend (Gemini, profanity filter, KV rate limiting). |

See `apps/web/README.md` for full app documentation.

## Getting started

```bash
pnpm install            # install all workspace deps

pnpm dev:web            # run the frontend (Vite)
pnpm dev:api            # run the Worker locally (wrangler dev)

pnpm build              # build the frontend
pnpm deploy             # deploy the Worker (wrangler deploy)
```

Each app keeps its own environment file:

- `apps/web/.env`  — `VITE_*` values consumed by Vite at build time.
- `apps/api/.env`  — Worker secrets (e.g. `GEMINI_API_KEY`).

Both are gitignored.
