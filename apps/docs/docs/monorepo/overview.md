---
title: Overview
sidebar_position: 1
---

# Spelling Creator (monorepo)

A pnpm monorepo containing the Spelling Lesson Maker web app and its Cloudflare
Worker API.

## Packages

| Path       | Package                 | Description                                                                                                                                                                                     |
| ---------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web` | `@spelling-creator/web` | Rsbuild + React frontend (shadcn/ui + Tailwind, Supabase, react-router). Built into `apps/web/dist` and served by the Worker as static assets.                                                  |
| `apps/api` | `@spelling-creator/api` | Cloudflare Worker backend (multi-provider AI suggestions — Gemini, OpenAI, Anthropic, Groq, Workers AI — profanity filter, KV rate limiting, R2 for lesson images and packed lesson histories). |
| `apps/mcp` | `@spelling-creator/mcp` | MCP server — lets an AI assistant author and publish lessons to the hub.                                                                                                                        |

See the [Web App](../web-app/overview.md) docs for full app documentation, and the
[MCP Server](../mcp-server/overview.md) docs for connecting an AI assistant to the hub.
