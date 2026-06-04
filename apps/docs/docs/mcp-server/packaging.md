---
title: Packaging the bundle
sidebar_position: 7
---

# Packaging the bundle

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
