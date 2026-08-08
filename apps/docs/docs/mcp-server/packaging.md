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

## The workspace dependency

`@spelling-creator/core` needs handling that npm can't provide. npm doesn't
understand the `workspace:` protocol and fails the whole install on it, and a
`file:` dependency would be symlinked — the exact thing that doesn't survive the
zip. So `pack` copies the core modules the server actually imports into the staged
`node_modules` as real files and removes the dependency from the staged manifest
before npm sees it.

That works because those modules (`richText`, `wikimedia`) are dependency-free.
Core's own dependency list — yjs, docx, isomorphic-git, supabase — belongs to its
browser modules and has no business in this bundle. `pack` doesn't assume that
silently: it walks the imports out from each module the server uses and **fails
the build** if any of them reaches a real package, naming the package and the file:

```
Vendoring @spelling-creator/core assumes the modules this server imports are
dependency-free, but they now reach real packages:
  dompurify (from src/richText.js)
```

If that fires, either keep the module dependency-free or add the package to
`apps/mcp/package.json`'s dependencies so npm vendors it into the bundle.

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
