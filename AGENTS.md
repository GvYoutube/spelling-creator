# Spelling Creator

## Overview

This is a React + `shadcn` project for making Spelling lessons.

It also has an MCP server; and its `package.json` and `manifest.json` version should be bumped on changes.

## Verifying in a Browser

If you have it installed, use the Playwright MCP for this. If not, use the Playwright CLI instead (see `playwright-cli --help`).

## Code Quality

Always lint and format:

```bash
pnpm run fmt && pnpm run lint
```

Formatting is [oxfmt](https://oxc.rs/docs/guide/usage/formatter) (`.oxfmtrc.json`)
and linting is [oxlint](https://oxc.rs/docs/guide/usage/linter) (`.oxlintrc.json`).
Both replaced Prettier and ESLint, so there is no `eslint.config.js`,
`.prettierrc` or `.prettierignore` any more.

Don't skip this. If you must, use `pnpm exec` or `pnpm dlx`, not `npx`.

## Docs (IMPORTANT!!!)

Always update the docs if necessary when changing or adding code. If the docs already contain outdated information, expand your scope to cover that info too.

## Try to avoid spinners

When applicable, try to use `shadcn` skeletons instead of spinners.
