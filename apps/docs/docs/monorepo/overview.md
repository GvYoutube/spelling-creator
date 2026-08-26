---
title: Overview
---

# Spelling Creator (monorepo)

A pnpm monorepo containing the Spelling Lesson Maker web app and its Cloudflare
Worker API.

## Packages

| Path            | Package                  | Description                                                                                                                                                                                                                                          |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`      | `@spelling-creator/web`  | Vite + React frontend (shadcn/ui + Tailwind, Supabase, react-router), installable as a PWA. Built into `apps/web/dist` and served by the Worker as static assets.                                                                                    |
| `apps/api`      | `@spelling-creator/api`  | Cloudflare Worker backend (multi-provider AI suggestions — Gemini, OpenAI, Anthropic, Groq, Workers AI — profanity filter, KV rate limiting, R2 for lesson images and packed lesson histories).                                                      |
| `apps/mcp`      | `@spelling-creator/mcp`  | MCP server — lets an AI assistant author and publish lessons to the hub.                                                                                                                                                                             |
| `apps/docs`     | `@spelling-creator/docs` | This VitePress site. Built into `apps/web/dist/docs` and served by the Worker at `/docs/` (see [Getting started](./getting-started.md#documentation-site)).                                                                                          |
| `packages/core` | `@spelling-creator/core` | Framework-agnostic lesson domain logic — question types, the spelling block, lesson-file import/export, hub search, Wikimedia Commons, the Yjs document, the portable half of version history, plus a browser tier for the IndexedDB/docx/pdf paths. |

## Shared code

`packages/core` holds the parts of the lesson model that aren't tied to React, to
the browser, or to the Worker runtime — so the same rules apply whether a lesson
is edited in the web app, validated by the Worker, or authored over MCP.

It has no build step and no barrel entry point: each module is its own subpath
export (`@spelling-creator/core/questions`, `/spelling`, `/jsonImport`, …), the
same convention `@spelling-creator/mcp` uses. That keeps browser-only modules out
of the Worker's import graph — importing `/questions` never drags in a module that
touches `document`.

Two modules in there (`image`, `jsonExport`) do still reach for the DOM in some of
their functions, and are consumed only by the web app today. They move behind a
`/browser` subpath when the rest of the browser-only tier is extracted.

Sharing a module does not mean collapsing two callers into one function. Where
the apps genuinely differ — the Commons integration returns a different hit shape
to the image dialog than to an MCP tool, and pages results only in the browser —
core holds the common plumbing and each app keeps a thin adapter over it. That
keeps each app's public contract and error wording its own.

The same split is what a change of frontend framework would rest on — see the
[frontend migration](./frontend-migration.md) record, which weighs the options
and is a proposal rather than a commitment.

## Storage, and the platform seam

The Worker's storage — lesson images and packed histories in R2, rate-limit
buckets in KV, cached renders in `caches.default` — sits behind three small
interfaces in `apps/api/src/platform/` rather than being called as bindings from
each route. See [the platform seam](./platform-seam.md) for the interfaces, the
executable conformance suite that defines them, and what it takes to add a host.

See the [Web App](../web-app/overview.md) docs for full app documentation, and the
[MCP Server](../mcp-server/overview.md) docs for connecting an AI assistant to the hub.
