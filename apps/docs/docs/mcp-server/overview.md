---
title: Overview
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

Every write is also a **version**. A lesson is a real git repository, and the
server commits each edit the way the web editor does, so what an assistant did
turns up in the lesson's History tab — with the diff, attributed to the assistant,
and revertable. See [Every edit is a version](./tools.md#every-edit-is-a-version).

It can also **fork** a lesson and open a **proposal** against it, rather than
writing to it — the assistant edits a copy, and you read the diff and decide.
That's the only route into a lesson somebody else wrote, and the one to use when
you'd rather check the assistant's work before it goes live. See
[Proposing changes instead of making them](./tools.md#proposing-changes-instead-of-making-them).

On a client that renders [MCP Apps](./interactive-views.md) — Claude on web, desktop and
mobile — some results come back as a small interface rather than as text: `search_images`
shows the Commons candidates as pictures, the assistant stands back rather than choosing
for you, and the one you click goes into the lesson. Everywhere else the same tools answer
in text, exactly as before.

Two ways to connect:

- **[Remote (hosted) mode](./remote-mode.md)** (recommended) — point your
  client at `https://spellingcreator.org/mcp` and approve access in your
  browser with a real OAuth flow. No token to manage.
- **[Local (stdio)](./setup.md)** — run the server yourself; useful for
  development or a client that only supports local servers.
