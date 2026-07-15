---
title: Overview
sidebar_position: 1
---

# `@spelling-creator/mcp`

An [MCP](https://modelcontextprotocol.io) server for the Spelling Creator hub. It
lets any MCP-capable AI assistant — Claude Desktop, Claude Code, Cursor, etc. —
**author and publish spelling lessons** to the hub on your behalf.

The assistant writes the content; the server gives it a structured, validated
path to a real lesson. It publishes through the **same Worker endpoints the web
app uses** (`/lessons`), authenticating as you with a Supabase token — so every
lesson goes through the existing validation, ban checks, and author attribution.
Nothing here bypasses the normal API.

Two ways to connect:

- **[Remote (hosted) mode](./remote-mode.md)** (recommended) — point your
  client at `https://spellingcreator.org/mcp` and approve access in your
  browser with a real OAuth flow. No token to manage.
- **[Local (stdio)](./setup.md)** — run the server yourself; useful for
  development or a client that only supports local servers.
