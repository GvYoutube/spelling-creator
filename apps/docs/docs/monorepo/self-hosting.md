---
title: Self-hosting
---

# Self-hosting

Spelling Creator's own instance runs on Cloudflare, and will keep doing so. But
nothing about the app requires it: the same API runs as a plain Node process
against Postgres and any S3-compatible object store, which is what this page is
about.

```bash
node apps/api/src/node/server.js
```

That serves the whole route table from
[`apps/api/src/app.js`](./platform-seam.md) — the lesson hub, images, git
history, proposals, moderation, notifications, profiles, feeds, the AI flow — the
built SPA from disk, and server-rendered HTML for the public read routes.

## What you need

| Piece          | Hosted instance               | Self-hosted                                   |
| -------------- | ----------------------------- | --------------------------------------------- |
| Runtime        | Cloudflare Workers            | Node ≥ 20                                     |
| Database       | Supabase Postgres             | Postgres + [PostgREST](https://postgrest.org) |
| Identity       | Supabase Auth                 | [GoTrue](https://github.com/supabase/auth)    |
| Object storage | R2                            | MinIO, Garage, Ceph RGW, SeaweedFS, B2, S3    |
| Expiring KV    | Workers KV                    | a table in the same Postgres                  |
| Response cache | `caches.default`              | your reverse proxy                            |
| AI             | Gemini/OpenAI/… or Workers AI | the same, or a local Ollama / vLLM            |

The database layer is the part that is already vendor-neutral and always was:
this API talks to Postgres over PostgREST and to identity over GoTrue, both
ordinary HTTP APIs with open-source servers. There are no stored procedures and
no `supabase-js` on the server, so running the two upstream projects yourself
needs no code change — only different URLs. Self-hosted Supabase works equally
well and bundles both.

## What you don't get

Three features need Cloudflare specifically, and are simply not registered on
this host rather than stubbed — a stub would be a promise the process can't keep.

- **Live collaboration.** A Durable Object per session, which is the part that
  gives one authoritative room per share code globally. Everything else about the
  editor works; `/collab` falls through to the SPA.
- **The remote MCP endpoint.** Also a Durable Object, plus a KV-backed OAuth 2.1
  server. The MCP server itself is unaffected and still runs
  [over stdio](../mcp-server/setup.md), which is how most people use it anyway.
- **Crawler prerendering and og-image screenshots.** Both need Browser Rendering.
  This matters less than it sounds: [server rendering](../web-app/server-rendering.md)
  already covers `/hub`, `/hub/:id` and `/users/:id` with real React for every
  visitor, and it runs here unchanged. What is lost is a headless-Chromium
  snapshot of `/` for crawlers, and link-preview images.

## Configuration

Everything is environment variables.

### Database and identity

| Variable                    | Meaning                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `SUPABASE_URL`              | Base URL serving `/rest/v1` (PostgREST) and `/auth/v1` (GoTrue). |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS. Server-only — never ship it to a browser.          |
| `SUPABASE_ANON_KEY`         | The publishable key the SPA uses for sign-in.                    |

The names are historical: they are the two upstream projects, whoever runs them.
Apply [`apps/api/schema.sql`](https://github.com/playforge-coding/spelling-creator/blob/main/apps/api/schema.sql)
once — it creates the hub tables and the `kv_store` table this host needs.

### Object storage

| Variable               | Required | Meaning                                                 |
| ---------------------- | -------- | ------------------------------------------------------- |
| `S3_ENDPOINT`          | yes      | e.g. `http://minio:9000`                                |
| `S3_ACCESS_KEY_ID`     | yes      |                                                         |
| `S3_SECRET_ACCESS_KEY` | yes      |                                                         |
| `S3_BUCKET_IMAGES`     | yes      | Lesson images, keyed by content hash.                   |
| `S3_BUCKET_GIT`        | yes      | Lesson history packfiles.                               |
| `S3_REGION`            | no       | Defaults to `us-east-1`, which MinIO and Garage expect. |
| `S3_FORCE_PATH_STYLE`  | no       | Defaults to path style. `false` for AWS virtual hosts.  |
| `S3_SESSION_TOKEN`     | no       | For temporary credentials.                              |

Two buckets rather than prefixes in one, matching how the Cloudflare deployment
is arranged, so moving between hosts is a copy rather than a rename.

### The server itself

| Variable              | Default           | Meaning                                          |
| --------------------- | ----------------- | ------------------------------------------------ |
| `PORT`                | `8787`            |                                                  |
| `HOST`                | `0.0.0.0`         |                                                  |
| `WEB_DIST`            | `apps/web/dist`   | The built SPA, with the docs site inside it.     |
| `ALLOWED_HOSTNAMES`   | —                 | Comma-separated origins allowed to call the API. |
| `CLIENT_IP_HEADER`    | `x-forwarded-for` |                                                  |
| `TRUSTED_PROXY_COUNT` | `1`               | How many proxies sit in front of this process.   |

`TRUSTED_PROXY_COUNT` is worth getting right. `x-forwarded-for` is a list that
each hop appends to, and the _client_ controls what is at the front — so the
trustworthy entry is the one your nearest proxy added, counted from the right.
The IP is what bans and rate limits are keyed on, so reading the leftmost entry
(the usual mistake) would let any caller forge both. With one reverse proxy the
default is correct; behind a CDN _and_ a proxy, set it to 2.

### AI

Any of the hosted providers, or a local model through
[`openai-compatible`](./getting-started.md#ai-providers) — Ollama, llama.cpp,
vLLM, LM Studio. An instance with no AI configured serves everything else; the
suggestion buttons report that they are unavailable.

## Notes on running it

**Put a reverse proxy in front.** The process serves static files itself so that
it _can_ run alone, but Caddy or nginx will do it better — ranges, compression,
and a real response cache, which is the one platform service this host
deliberately implements as a no-op. Terminate TLS there too.

**It is stateless.** Run as many processes as you like behind the proxy; nothing
is held in memory between requests.

**Expired `kv_store` rows** are treated as absent on read and swept as they are
passed, so nothing depends on housekeeping. `schema.sql` has a `pg_cron` snippet
to reclaim the rows nobody asks for again.

**Migrating from Cloudflare** is a bucket copy and a database dump: the object
keys and the schema are identical, which is deliberate.
