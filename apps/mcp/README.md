# `@spelling-creator/mcp`

An [MCP](https://modelcontextprotocol.io) server for the Spelling Creator hub. It
lets any MCP-capable AI assistant — Claude Desktop, Claude Code, Cursor, etc. —
**author and publish spelling lessons** to the hub on your behalf.

The assistant writes the content; the server gives it a structured, validated path
to a real lesson. It publishes through the **same Worker endpoints the web app
uses** (`/lessons`), authenticating as you with a Supabase token — so every lesson
goes through the existing validation, ban checks, and author attribution. Nothing
here bypasses the normal API.

## Documentation

Full documentation lives on the docs site under **MCP Server**:
**https://spellingcreator.org/docs/mcp-server/overview**

- [Overview](https://spellingcreator.org/docs/mcp-server/overview)
- [Tools](https://spellingcreator.org/docs/mcp-server/tools) — including patch vs. replace and the lesson shape
- [Install as a one-click bundle (.mcpb)](https://spellingcreator.org/docs/mcp-server/install-bundle)
- [Setup (manual / for development)](https://spellingcreator.org/docs/mcp-server/setup)
- [Configuration](https://spellingcreator.org/docs/mcp-server/configuration)
- [Development](https://spellingcreator.org/docs/mcp-server/development)
- [Packaging the bundle](https://spellingcreator.org/docs/mcp-server/packaging)
- [Remote (hosted) mode](https://spellingcreator.org/docs/mcp-server/remote-mode)

The docs source is in `apps/docs/docs/mcp-server`.

If your client supports remote MCP servers, connecting to
`https://spellingcreator.org/mcp` is simpler — no token to manage, just a
browser "Connect" flow. See [Remote mode](https://spellingcreator.org/docs/mcp-server/remote-mode).
The quick start below is for the local stdio server.

## Quick start

```bash
pnpm install
pnpm --filter @spelling-creator/mcp login   # get a Supabase session
pnpm --filter @spelling-creator/mcp start   # run the stdio server
```

See **[Setup](https://spellingcreator.org/docs/mcp-server/setup)** for connecting
your assistant and **[Configuration](https://spellingcreator.org/docs/mcp-server/configuration)**
for the available environment variables.
