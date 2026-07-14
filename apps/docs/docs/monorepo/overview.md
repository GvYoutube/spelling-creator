---
title: Overview
sidebar_position: 1
---

# Spelling Creator (monorepo)

A pnpm monorepo containing the Spelling Lesson Maker web app and its Cloudflare
Worker API.

## Packages

| Path       | Package                 | Description                                                                                                               |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/web` | `@spelling-creator/web` | Vite + React frontend (MUI, Supabase, react-router). Deploys to GitHub Pages.                                             |
| `apps/api` | `@spelling-creator/api` | Cloudflare Worker backend (Gemini, profanity filter, KV rate limiting, R2 for lesson images and packed lesson histories). |
| `apps/mcp` | `@spelling-creator/mcp` | MCP server — lets an AI assistant author and publish lessons to the hub.                                                  |

See the [Web App](../web-app/overview.md) docs for full app documentation, and the
[MCP Server](../mcp-server/overview.md) docs for connecting an AI assistant to the hub.
