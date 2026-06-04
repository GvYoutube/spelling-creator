---
title: Install as a one-click bundle (.mcpb)
sidebar_position: 3
---

# Install as a one-click bundle (.mcpb) — easiest

The server ships as an [MCPB bundle](https://github.com/anthropics/mcpb): a single
`.mcpb` file Claude Desktop installs with one click — no terminal, no JSON to edit.

1. Build it (see [Packaging the bundle](./packaging.md)) or grab a prebuilt
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
