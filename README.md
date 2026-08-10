# Spelling Creator (monorepo)

A pnpm monorepo containing the Spelling Lesson Maker web app and its Cloudflare
Worker API.

| Path            | Package                  | Description                                                                                                                                   |
| --------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`      | `@spelling-creator/web`  | Vite + React frontend (shadcn/ui + Tailwind, Supabase, react-router), installable as a PWA. Built into `apps/web/dist`, served by the Worker. |
| `apps/api`      | `@spelling-creator/api`  | Cloudflare Worker backend (multi-provider AI suggestions, profanity filter, KV rate limiting, R2 lesson images).                              |
| `apps/mcp`      | `@spelling-creator/mcp`  | MCP server — lets an AI assistant author and publish lessons to the hub.                                                                      |
| `apps/docs`     | `@spelling-creator/docs` | The VitePress documentation site published at `/docs/`.                                                                                       |
| `packages/core` | `@spelling-creator/core` | Framework-agnostic lesson domain logic shared by the apps above.                                                                              |

## Documentation

Full documentation lives on the docs site: **https://spellingcreator.org/docs/**

- **[Monorepo](https://spellingcreator.org/docs/monorepo/overview)** — workspace
  layout, getting started, and lesson image storage (R2 + IndexedDB).
- **[Web App](https://spellingcreator.org/docs/web-app/overview)** — the Spelling
  Lesson Maker: features, routing, AI helpers, image search, Google Docs export,
  live collaboration, the lesson hub, the export pipeline, and
  [installing it as an offline-capable app](https://spellingcreator.org/docs/web-app/pwa-and-offline).
- **[MCP Server](https://spellingcreator.org/docs/mcp-server/overview)** — connect
  an AI assistant to author and publish lessons to the hub.

The docs source is in `apps/docs/docs`.

## Quick start

```bash
pnpm install            # install all workspace deps
pnpm dev:web            # run the frontend (Vite)
pnpm dev:api            # run the Worker locally (wrangler dev)
```

See **[Getting started](https://spellingcreator.org/docs/monorepo/getting-started)**
for the full set of commands and per-app environment files.
