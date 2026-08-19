---
title: Packaging the bundle
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

## Publishing a release

Releases are cut by hand. There is no CI workflow for this — an
`mcpb-release.yml` existed once and was removed as broken, so the tag-push
trigger some older notes describe does nothing.

1. Bump the version in **both** `apps/mcp/manifest.json` and
   `apps/mcp/package.json`. They must match — the release tag and asset name are
   derived from the manifest.

2. Validate and build:

   ```bash
   pnpm --filter @spelling-creator/mcp validate
   pnpm --filter @spelling-creator/mcp pack
   ```

   `pack` also leaves an `npm pack` tarball in the repo root as a side effect of
   vendoring; it is not the release artifact and can be deleted.

3. Give the asset a versioned, self-describing name:

   ```bash
   version=$(node -p "require('./apps/mcp/manifest.json').version")
   cp apps/mcp/dist/spelling-creator-hub.mcpb \
      "apps/mcp/dist/spelling-creator-hub-$version.mcpb"
   ```

4. Create the GitHub Release and attach it:

   ```bash
   gh release create "mcp-v$version" \
     --title "Spelling Creator Hub MCPB $version" \
     --notes "Install by opening the attached \`.mcpb\` file with Claude Desktop." \
     "apps/mcp/dist/spelling-creator-hub-$version.mcpb"
   ```

Users install the bundle by opening the downloaded `.mcpb` file with Claude
Desktop.
