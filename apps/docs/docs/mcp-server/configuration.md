---
title: Configuration
sidebar_position: 6
---

# Configuration

These variables configure the **local stdio server** only — see
[Setup](./setup.md). [Remote mode](./remote-mode.md) needs no client-side
configuration at all; the OAuth "Connect" flow replaces all of it.

All optional except a token. See `.env.example`. Set these in the environment or
the MCP client's `env` block (a local `.env` in this folder also works for
`pnpm start`).

| Variable                             | Default                                       | Purpose                                                               |
| ------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------- |
| `SPELLING_CREATOR_API_URL`           | `https://spellingcreator.org`                 | Worker API base (use `http://localhost:8787` against `pnpm dev:api`). |
| `SUPABASE_REFRESH_TOKEN`             | —                                             | Long-lived credential; auto-refreshed.                                |
| `SUPABASE_ACCESS_TOKEN`              | —                                             | Short-lived session JWT (≈1h).                                        |
| `SPELLING_CREATOR_SESSION_FILE`      | `~/.config/spelling-creator-mcp/session.json` | Where the `login` session is stored.                                  |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | production project                            | Override only for a fork.                                             |
