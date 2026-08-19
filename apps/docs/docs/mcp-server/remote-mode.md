---
title: Remote (hosted) mode
---

# Remote (hosted) mode

Point an MCP client at `https://spellingcreator.org/mcp` and it connects over
Streamable HTTP with a real OAuth 2.1 "Connect" flow — no token to copy, paste,
or store. This is the recommended way to connect a client that supports remote
MCP servers (claude.ai, Claude Desktop's remote connectors, Cursor, etc.); the
local [stdio setup](./setup.md) remains the CLI-first path.

## How it works

1. The client discovers the server's OAuth metadata and registers itself
   automatically (RFC 7591 Dynamic Client Registration) — nothing to set up on
   your end.
2. It opens your browser to `/authorize`, which redirects to an ordinary page
   of the web app at `/oauth/authorize`. If you're not already signed in, it
   offers the same magic-link sign-in as [`/login`](https://spellingcreator.org/login).
3. You see a consent screen — which client is connecting and what it can do —
   and choose **Approve** or **Deny**.
4. The client receives its own access/refresh token pair and starts calling
   tools. No Supabase token is ever shown to you or passed to the client; the
   server holds your session and mints requests to the hub's normal endpoints
   on your behalf.

The tool layer (`src/tools.js`) and API client (`src/api.js`) are the exact
same code the [stdio server](./setup.md) uses — the same tools, the same
validation, the same author attribution.

## Worker-side implementation

The whole thing is implemented in `apps/api`, not `apps/mcp` — the MCP package
only supplies the two remote-specific pieces the Worker composes:

- **`src/worker.js`** (`@spelling-creator/mcp/worker`) — `buildMcpServer`
  (build a connection-scoped `McpServer` given any auth provider) and
  `grantAuth` (an auth provider seeded from an OAuth grant's `props`, with the
  same getAccessToken()/forceRefresh() shape the stdio auth provider has).
- **`src/auth.js`** (`@spelling-creator/mcp/auth`) — `refreshSupabaseSession`,
  the plain Supabase refresh-token-exchange call shared by the stdio server,
  `grantAuth`'s fallback, and the Worker's token endpoint (below).

On the Worker side (`apps/api`):

- **`src/routes/mcp.js`** wires up [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
  with `HubMcp` (an `McpAgent` from the Cloudflare Agents SDK, one per MCP
  connection) as the `/mcp` API handler, and the existing Hono `app` as the
  `defaultHandler` for everything else. Supabase is the upstream identity: a
  grant's `props` carry a Supabase session captured at consent time, and a
  `tokenExchangeCallback` rotates it in step with the MCP client's own OAuth
  token refresh (kept a little shorter than Supabase's ~1h JWT lifetime), so a
  tool call's Supabase access token is normally already fresh with no extra
  round trip. `grantAuth` is the defense-in-depth fallback for a connection
  that outlives that cadence.
- **`src/routes/oauth.js`** implements the consent flow's two small endpoints
  (`GET /oauth/request`, `POST /oauth/approve`) that the `/oauth/authorize`
  web page calls. `/authorize` itself, `/token`, and dynamic client
  registration (`/register`) are otherwise implemented by the OAuthProvider
  library.
- The consent page is `apps/web/src/pages/OAuthAuthorizePage.jsx`, an ordinary
  route (`/oauth/authorize`) of the existing SPA.

### Infrastructure

Deploying this needs a KV namespace for the OAuth provider's grant/token
storage (also used for the consent flow's short-lived pending-request state)
and a Durable Object binding for `HubMcp`:

```bash
wrangler kv namespace create OAUTH_KV
```

then fill the returned id into `OAUTH_KV` in `apps/api/wrangler.jsonc` (the
`HubMcp` Durable Object binding and its SQLite migration are already
declared). No new secrets are needed — the flow reuses the existing
`SUPABASE_SERVICE_ROLE_KEY` (via the same `verifySupabaseUser` every other
route uses) and the publishable `SUPABASE_ANON_KEY`/`SPELLING_CREATOR_API_URL`
vars already in `wrangler.jsonc`.

### A note on the `agents` dependency

`apps/api` depends on `agents` (the Cloudflare Agents SDK, for `McpAgent`) and
`@cloudflare/workers-oauth-provider`. One of `agents`' own transitive
dependencies, `@cfworker/json-schema`, probes `self.location` at module load
to pick a default base URI and throws on Workers' `location` global under this
Worker's compatibility settings — crashing the whole Worker before any request
is handled. Because the crash happens while Cloudflare evaluates the script's
top-level scope, the _upload_ fails too, with error code 10021 — the deploy
never produces a broken version, it just refuses.

This is patched via `pnpm patch` to fall back to the library's own safe default
instead of throwing; `pnpm install` applies it automatically.

Three patches are needed, not one, because two of `agents`' other dependencies
**inline** their own copy of `@cfworker/json-schema` into their published
bundles. A `patchedDependencies` entry only rewrites the package pnpm installs,
so it cannot reach a copy baked into someone else's `dist/`:

| Patch                                               | Fixes                                           |
| --------------------------------------------------- | ----------------------------------------------- |
| `patches/@cfworker__json-schema@4.1.1.patch`        | the real package                                |
| `patches/@modelcontextprotocol__client@2.0.0.patch` | its copy in `dist/cfWorkerProvider-*.{mjs,cjs}` |
| `patches/@modelcontextprotocol__server@2.0.0.patch` | its copy in `dist/cfWorkerProvider-*.{mjs,cjs}` |

All three are registered under `patchedDependencies` in `pnpm-workspace.yaml`.

Two traps when this resurfaces after a dependency bump. First, the stack trace
points at a path like
`node_modules/.pnpm/@modelcontextprotocol+client@2.0.0/node_modules/node_modules/.pnpm/@cfworker+json-schema@4.1.1/…`
that does not exist in your tree — it is a sourcemap path from the upstream
package's own build machine, and it is what gives the inlining away. Second,
the patched copies live in `.pnpm` directories carrying a `_patch_hash=` suffix,
so a path _without_ that suffix is an unpatched copy.

To check the fix actually reaches the shipped bundle rather than trusting the
install, bundle the Worker and grep the output — every hit should be inside a
`try`:

```bash
pnpm --filter @spelling-creator/api exec wrangler deploy --dry-run --outdir=/tmp/dryrun
grep -c 'initialBaseURI[0-9]* = typeof self' /tmp/dryrun/index.js   # expect 0
```
