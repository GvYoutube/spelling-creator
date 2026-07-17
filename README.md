# Spelling Creator (monorepo)

A pnpm monorepo containing the Spelling Lesson Maker web app and its Cloudflare
Worker API.

| Path       | Package                 | Description                                                                                       |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/web` | `@spelling-creator/web` | Rsbuild + React frontend (shadcn/ui + Tailwind, Supabase, react-router). Deploys to GitHub Pages. |
| `apps/api` | `@spelling-creator/api` | Cloudflare Worker backend (Gemini, profanity filter, KV rate limiting).                           |
| `apps/mcp` | `@spelling-creator/mcp` | MCP server — lets an AI assistant author and publish lessons to the hub.                          |

## Documentation

Full documentation lives on the docs site: **https://spellingcreator.org/docs/**

- **[Monorepo](https://spellingcreator.org/docs/monorepo/overview)** — workspace
  layout, getting started, and lesson image storage (R2 + IndexedDB).
- **[Web App](https://spellingcreator.org/docs/web-app/overview)** — the Spelling
  Lesson Maker: features, routing, AI helpers, image search, Google Docs export,
  live collaboration, the lesson hub, and the export pipeline.
- **[MCP Server](https://spellingcreator.org/docs/mcp-server/overview)** — connect
  an AI assistant to author and publish lessons to the hub.

The docs source is in `apps/docs/docs`.

## Quick start

```bash
pnpm install            # install all workspace deps
pnpm dev:web            # run the frontend (Rsbuild)
pnpm dev:api            # run the Worker locally (wrangler dev)
```

See **[Getting started](https://spellingcreator.org/docs/monorepo/getting-started)**
for the full set of commands and per-app environment files.
