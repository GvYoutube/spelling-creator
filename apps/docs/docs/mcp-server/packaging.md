---
title: Packaging the bundle
sidebar_position: 8
---

# Packaging the bundle

```bash
pnpm --filter @spelling-creator/mcp validate   # check manifest.json against the MCPB schema
pnpm --filter @spelling-creator/mcp pack       # build dist/spelling-creator-hub.mcpb
```

`pack` stages a clean copy of the runtime files and vendors **production**
dependencies with a flat `npm install --omit=dev` before zipping — necessary
because this is a pnpm workspace whose `node_modules` are symlinks that wouldn't
zip into a working bundle. The manifest (`manifest.json`) declares the Node server
entry point, the `user_config` fields Claude Desktop collects (the refresh token
is `sensitive`, so it's keychain-stored), and how they're injected as env vars the
server already reads. Bundle artifacts (`build/`, `dist/`, `*.mcpb`) are gitignored.

## Publishing a release (CI)

The [`.github/workflows/mcpb-release.yml`](https://github.com/playforge-coding/spelling-creator/blob/master/.github/workflows/mcpb-release.yml)
workflow validates the manifest, runs the same `pack` command, and attaches the
resulting `.mcpb` to a **GitHub Release**. It triggers two ways:

- **Push a tag** matching `mcp-v*` — the release is created for that tag:

  ```bash
  # bump the version in apps/mcp/manifest.json and package.json first, then:
  git tag mcp-v0.1.4
  git push origin mcp-v0.1.4
  ```

- **Run it manually** from the Actions tab (`workflow_dispatch`) — the tag and
  release name are derived from the version in `apps/mcp/manifest.json`
  (e.g. `mcp-v0.1.4`).

The asset is uploaded as `spelling-creator-hub-<version>.mcpb`. Users install it
by opening that file with Claude Desktop.
