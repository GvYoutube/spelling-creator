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

## With Docker

The repository ships a `Dockerfile` and an example `docker-compose.yml` that
stands the whole thing up — Postgres, PostgREST, GoTrue, RustFS and a Caddy
gateway around the app.

The object store is RustFS rather than MinIO, whose community edition is no
longer somewhere to point self-hosters. Nothing in the app knows which it is —
it speaks plain S3 — so Garage, SeaweedFS, Ceph RGW or real S3 are a change of
image and endpoint and nothing else. The service is named `storage` for its role
rather than its implementation to keep that swap a one-line edit.

```bash
./scripts/generate-env.sh   # writes .env with every credential filled in
# then set PUBLIC_URL / PUBLIC_HOSTNAME and the SMTP block in .env
docker compose up -d --build
```

The generator is POSIX `sh` and `openssl`, so it needs nothing installed —
asking someone whose only requirement is Docker to add a Node toolchain to
produce a config file would be a silly thing to ask. If `openssl` somehow isn't
there, any container has it:

```bash
docker run --rm -v "$PWD:/w" -w /w alpine/openssl:latest sh scripts/generate-env.sh
```

Use the generator rather than copying `.env.example` by hand. `ANON_KEY` and
`SERVICE_ROLE_KEY` are JWTs that must be signed with the same `JWT_SECRET`
PostgREST and GoTrue verify against, and a value that is not a valid token fails
in a way that points everywhere except at itself: PostgREST reports a signing
error, GoTrue reports a permissions error, and the app answers 502. The
dependency check below now catches it directly, but not generating a broken one
is better still.

`PUBLIC_URL` is baked into the SPA at build time, so set it before the build, not
after.

That is the whole of it — there is no schema step to remember, because the
ordering it depends on is not something to leave to a reader. A one-shot
`schema` service waits for GoTrue to create `auth.users` on its first migration,
then applies `apps/api/schema.sql` with `ON_ERROR_STOP`, and the app waits for it
to finish.

Both halves of that matter. Every hub table references `auth.users`, so applying
the schema before auth has migrated fails _every_ statement — and `psql` walks
past errors and exits 0, so the failure is silent. What you get is an empty
database, PostgREST reporting `0 Relations`, and the app answering 502.

The related trap is PostgREST's schema cache, which it builds once at startup: a
table created afterwards is invisible to it. The stack installs the same
`pgrst_watch` event trigger Supabase ships, so any DDL tells PostgREST to
re-read. If you ever suspect it has gone stale anyway,
`docker compose restart postgrest` settles it.

Filling in `.env` is not optional. Every credential is declared as a required
variable, so `docker compose up` without a filled-in `.env` stops and names what
is missing rather than standing the stack up with blank passwords. The SMTP
settings are the exception and default to empty: the stack comes up so you can
look at it, and only sign-in is broken until you fill them in.

Two things about it are worth understanding before adapting it.

**One origin serves both `/rest/v1/*` and `/auth/v1/*`.** That is how Supabase
presents PostgREST and GoTrue, and this API was written against it. Nothing in
the compose file is Supabase — the `gateway` service is an ordinary reverse proxy
joining the two upstream projects under one origin, doing the job Kong does on
Supabase's own hosting. It is also the proxy that should sit in front of the app
anyway.

**The `VITE_*` values are build arguments, not runtime environment.** Vite
substitutes them into the SPA bundle at build time, so they are baked into the
image: an instance pointed at a different public URL needs `docker compose
build`, not just a restart. That is a property of shipping a static SPA rather
than a choice made here.

The compose file terminates no TLS and takes its credentials from `.env` with
example values, both deliberately. It is a starting point, not a deployment — a
compose file that pretended otherwise would be worse than one that is obviously
an example.

## When something doesn't work

Start here, before reading any of the rest of this page:

```bash
docker compose logs app
```

The server asks every dependency whether it is actually working, once it has
started listening, and prints the answer:

```
Dependency check:
  [ok  ] configuration: database and identity credentials are set
  [ok  ] database: PostgREST answered (HTTP 200)
  [FAIL] schema: PostgREST cannot see public.lessons (HTTP 404 PGRST205: Could
         not find the table 'public.lessons' in the schema cache)
         Either apps/api/schema.sql was never applied, or PostgREST has a stale
         cache. Check the tables exist, then restart PostgREST if they do.
  [ok  ] identity: the auth service is healthy
  [FAIL] identity-admin: the admin API refused the service-role key (HTTP 403)
         The auth service must allow the "service_role" claim to call /admin —
         on GoTrue that is GOTRUE_JWT_ADMIN_ROLES.
  [ok  ] images: the bucket exists and is readable
```

Each check is written to distinguish causes rather than to confirm health, because
the causes are what look alike from outside. Reaching PostgREST is not the same
as PostgREST being able to see the tables. Reaching the auth service is not the
same as being allowed to call its admin API — that one looks like a working
instance right up until somebody opens a profile. A bucket that answers is not
the same as a bucket that exists.

Results carry the upstream's own error code, not a paraphrase, because
`PGRST205` and `NoSuchBucket` are the strings worth searching for.

To ask again without restarting, once `ADMIN_TOKEN` is set:

```bash
curl -H "X-Admin-Token: $ADMIN_TOKEN" "http://localhost:8080/_diagnostics?format=text"
```

`GET /_health` is separate, public and cheap: it answers whether the process is
up and routing, and deliberately checks nothing else — a health check that fails
when a dependency hiccups makes an orchestrator restart a process that was fine.

## What you need

| Piece          | Hosted instance               | Self-hosted                                   |
| -------------- | ----------------------------- | --------------------------------------------- |
| Runtime        | Cloudflare Workers            | Node ≥ 20                                     |
| Database       | Supabase Postgres             | Postgres + [PostgREST](https://postgrest.org) |
| Identity       | Supabase Auth                 | [GoTrue](https://github.com/supabase/auth)    |
| Object storage | R2                            | RustFS, Garage, Ceph RGW, SeaweedFS, B2, S3   |
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
| `S3_ENDPOINT`          | yes      | e.g. `http://storage:9000`                              |
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

### Sign-in

The hosted instance signs people in with a magic link, which is the nicer
experience and needs a mail server. A self-hosted one frequently has no SMTP at
all, which would otherwise leave it with no way for anyone to sign in — so the
instance chooses:

| `AUTH_MODE`  | What the login page offers | Needs mail |
| ------------ | -------------------------- | ---------- |
| `password`   | Email and password         | no         |
| `magic-link` | A one-time emailed link    | yes        |
| `both`       | Either, visitor's choice   | yes        |

The compose file defaults to `password`, because an instance reaching for it is
more likely to have no mail server than to have one. `AUTH_MODE` is baked into
the SPA at build time, so changing it means a rebuild.

Two things follow from running without mail, and both are worth deciding
deliberately rather than discovering:

- **New accounts are auto-confirmed** (`AUTH_AUTOCONFIRM`, on by default),
  because a confirmation nobody can receive would make registration a dead end.
  That means anyone can register with an address they don't own. An instance
  open to the internet with no SMTP should also set `GOTRUE_DISABLE_SIGNUP=true`
  and create accounts by hand.
- **There is no password reset.** Resetting one means emailing a link. Without
  mail, a forgotten password is an admin job — GoTrue's admin API, or a row in
  `auth.users`.

With SMTP configured, set `AUTH_AUTOCONFIRM=false` so addresses get verified
properly.

Passwords must be at least 8 characters. The login form checks that before
submitting and `GOTRUE_PASSWORD_MIN_LENGTH` enforces it, so the two agree.

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
