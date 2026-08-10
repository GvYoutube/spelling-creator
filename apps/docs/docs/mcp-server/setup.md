---
title: Setup (manual / for development)
---

# Setup (manual / for development)

> If your client supports remote MCP servers (claude.ai, Claude Desktop's
> remote connectors, Cursor), connecting to
> `https://spellingcreator.org/mcp` is simpler: click "Connect", approve in
> your browser, done — no token to manage. See
> **[Remote (hosted) mode](./remote-mode.md)**. The steps below are for
> running the server yourself (stdio), e.g. for local development or a client
> that only supports local servers.

## 1. Install

From the monorepo root:

```bash
pnpm install
```

## 2. Sign in (get a token)

Publishing happens as a real hub user, so the server needs a Supabase session.
You also need a **display name** set on your account (do this once in the web app
at spellingcreator.org) or publishing is rejected.

```bash
pnpm --filter @spelling-creator/mcp login
```

This emails you a one-time code, verifies it, and saves a session to
`~/.config/spelling-creator-mcp/session.json`. The server reads that file and
**auto-refreshes** the short-lived access token, so it keeps working for weeks.

> If your Supabase email shows only a magic _link_ and no code, run
> `pnpm --filter @spelling-creator/mcp login -- --paste` instead and paste the
> `access_token` / `refresh_token` from the web app's
> `sb-…-auth-token` localStorage entry.

Alternatively, skip the helper and provide a token via env (below):
`SUPABASE_REFRESH_TOKEN` (long-lived, recommended) or `SUPABASE_ACCESS_TOKEN`
(expires in ~1h).

## 3. Connect your assistant

The server runs over stdio. Point your MCP client at the bin.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "spelling-creator": {
      "command": "node",
      "args": ["/absolute/path/to/spelling-creator/apps/mcp/src/stdio.js"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add spelling-creator -- node /absolute/path/to/spelling-creator/apps/mcp/src/stdio.js
```

If you didn't use the `login` helper, pass the token in the client's `env` block,
e.g. `"env": { "SUPABASE_REFRESH_TOKEN": "..." }`.

Then ask your assistant something like: _"Make a Year-3 spelling lesson about
volcanoes with a reading passage, a spelling list, and three questions, and save
it as a draft."_ Use `whoami` first if you hit a permission error.
