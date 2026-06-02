# `@spelling-creator/mcp`

An [MCP](https://modelcontextprotocol.io) server for the Spelling Creator hub. It
lets any MCP-capable AI assistant — Claude Desktop, Claude Code, Cursor, etc. —
**author and publish spelling lessons** to the hub on your behalf.

The assistant writes the content; the server gives it a structured, validated
path to a real lesson. It publishes through the **same Worker endpoints the web
app uses** (`/lessons`), authenticating as you with a Supabase token — so every
lesson goes through the existing validation, ban checks, and author attribution.
Nothing here bypasses the normal API.

## Tools

| Tool                   | What it does                                                                  |
| ---------------------- | ----------------------------------------------------------------------------- |
| `whoami`               | Confirm the session is valid and show the publishing display name.            |
| `create_lesson`        | Build and save a new lesson (draft by default; `published: true` to share).   |
| `update_lesson`        | Replace a lesson's title/content (author only).                               |
| `get_lesson`           | Fetch one lesson with its full content (read before editing / as a template). |
| `list_my_lessons`      | List your own lessons (drafts + published).                                   |
| `list_hub_lessons`     | Browse published lessons for inspiration / de-duplication.                    |
| `set_lesson_published` | Toggle a lesson between public and private draft.                             |
| `delete_lesson`        | Permanently delete one of your lessons.                                       |

### Lesson shape the assistant fills

A lesson is **sections** of **blocks**. Block types:

- **`text`** — a paragraph. Put words you're teaching the spelling of in **ALL
  CAPS**; the app highlights them as spelling words.
- **`spelling`** — an explicit word list: `{ "type": "spelling", "words": ["BECAUSE", "FRIEND"] }`.
- **`question`** — a quiz question with a `questionType`:
  - `number` → `answer` (numeric)
  - `single` → `answer` (one text answer)
  - `multiple` → `answers` (array of accepted answers)
  - `open` → `exampleAnswer` (free response)
  - `background` → `background` + `answer` (needs prior knowledge)

Image blocks aren't supported over MCP yet (they need a separate binary upload).

## Install as a one-click bundle (.mcpb) — easiest

The server ships as an [MCPB bundle](https://github.com/anthropics/mcpb): a single
`.mcpb` file Claude Desktop installs with one click — no terminal, no JSON to edit.

1. Build it (see [Packaging](#packaging-the-bundle)) or grab a prebuilt
   `spelling-creator-hub.mcpb`.
2. **Open the file with Claude Desktop.** It shows an install dialog and asks for
   your **Supabase refresh token** (stored securely in your OS keychain) and,
   optionally, the hub API URL.
3. Get a refresh token by running `pnpm --filter @spelling-creator/mcp login`
   (it prints where the session is saved — the `refresh_token` is in that file),
   or copy `refresh_token` from the web app's `sb-…-auth-token` localStorage
   entry. You also need a **display name** set on your account (do it once in the
   web app) or publishing is rejected.

That's it — the bundle carries Node.js dependencies and the manifest declares the
config, so Claude Desktop injects your token and launches the server for you.

## Setup (manual / for development)

### 1. Install

From the monorepo root:

```bash
pnpm install
```

### 2. Sign in (get a token)

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

### 3. Connect your assistant

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

## Configuration

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

## Development

```bash
pnpm --filter @spelling-creator/mcp start   # run the stdio server directly
pnpm --filter @spelling-creator/mcp test    # doc-builder + auth + tool-surface smoke tests
```

## Packaging the bundle

```bash
pnpm --filter @spelling-creator/mcp validate   # check manifest.json against the MCPB schema
pnpm --filter @spelling-creator/mcp icon       # regenerate icon.png (only if you change it)
pnpm --filter @spelling-creator/mcp pack       # build dist/spelling-creator-hub.mcpb
```

`pack` stages a clean copy of the runtime files and vendors **production**
dependencies with a flat `npm install --omit=dev` before zipping — necessary
because this is a pnpm workspace whose `node_modules` are symlinks that wouldn't
zip into a working bundle. The manifest (`manifest.json`) declares the Node server
entry point, the `user_config` fields Claude Desktop collects (the refresh token
is `sensitive`, so it's keychain-stored), and how they're injected as env vars the
server already reads. Bundle artifacts (`build/`, `dist/`, `*.mcpb`) are gitignored.

## Remote (hosted) mode

The tool layer is transport-agnostic. `src/worker.js` provides the remote-specific
pieces (`buildMcpServer`, `staticTokenAuth`) so the same tools can later be mounted
as an HTTP route on the existing Worker (`apps/api`) for clients like claude.ai —
the recommended bridge there is the Agents SDK `McpAgent`. Wiring that route is the
one remaining step; the local stdio server above is the supported path today.
