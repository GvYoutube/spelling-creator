# Spelling Creator (monorepo)

A pnpm monorepo containing the Spelling Lesson Maker web app and its Cloudflare
Worker API.

## Packages

| Path       | Package                 | Description                                                                   |
| ---------- | ----------------------- | ----------------------------------------------------------------------------- |
| `apps/web` | `@spelling-creator/web` | Vite + React frontend (MUI, Supabase, react-router). Deploys to GitHub Pages. |
| `apps/api` | `@spelling-creator/api` | Cloudflare Worker backend (Gemini, profanity filter, KV rate limiting).       |

See `apps/web/README.md` for full app documentation.

## Getting started

```bash
pnpm install            # install all workspace deps

pnpm dev:web            # run the frontend (Vite)
pnpm dev:api            # run the Worker locally (wrangler dev)

pnpm build              # build the frontend
pnpm deploy             # deploy the Worker (wrangler deploy)
```

Each app keeps its own environment file:

- `apps/web/.env` — `VITE_*` values consumed by Vite at build time.
- `apps/api/.env` — Worker secrets (e.g. `GEMINI_API_KEY`).

Both are gitignored.

## Lesson images (binary, R2 + IndexedDB)

Lesson images are stored as binary, keyed by their SHA-256 content hash — not as
base64 inside the lesson doc. Locally they live as blobs in IndexedDB (so large
drafts aren't capped by `localStorage`'s ~5 MB quota); in the cloud they live in
an R2 bucket. The lesson doc only references images by hash.

Worker endpoints (`apps/api/src/index.js`):

- `GET /images/:hash` — public; serves the image bytes from R2 (immutable cache).
- `PUT /images/:hash` — authenticated (Supabase JWT); verifies the body hashes to
  `:hash` before storing. Called on save/publish to upload locally-drafted images.

Setup:

```bash
# Create the R2 bucket the IMAGES binding points at (see apps/api/wrangler.jsonc).
wrangler r2 bucket create spelling-creator-images

# Secret for the one-time backfill endpoint (below).
wrangler secret put ADMIN_MIGRATE_TOKEN
```

### Migrating existing lessons

Existing cloud lessons (with base64 images inline) are converted by a one-time,
idempotent backfill. It's gated by the `ADMIN_MIGRATE_TOKEN` secret and pages
through lessons, uploading each inline image to R2 and rewriting the doc:

```bash
# Repeat, passing the returned nextCursor each time, until nextCursor is null.
curl -X POST https://<worker-host>/admin/migrate-images \
  -H "X-Admin-Token: $ADMIN_MIGRATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cursor": 0, "limit": 25}'
```

Local drafts migrate automatically on first load (old `localStorage` doc → IndexedDB).
Readers tolerate legacy base64 throughout, so the backfill can run any time after
deploy. Deploy order: deploy the Worker (so `/images` exists) → ship the web build
→ run the backfill.

### Staying within R2's free tier

R2's free tier allows 10 GB-month storage, 1M class-A (write) ops/month, and 10M
class-B (read) ops/month. The design keeps usage well inside these:

- **Class A (writes)** ≈ number of _distinct_ images, not number of saves.
  Images are content-addressed, so `PUT /images/:hash` first does a `head()`
  (class B) and only `put()`s when the object is missing; the client also caches
  which hashes it has uploaded this session, so re-saving a lesson uploads
  nothing new. Identical images (across all users/lessons) share one object.
- **Class B (reads)** stays low because `GET /images/:hash` responses are cached
  at Cloudflare's edge (the bytes are immutable, so they're safe to cache
  forever). Repeat views of a popular lesson — and the og-image/prerender
  browser — are served from cache and don't hit R2.
- **Storage** is bounded by global content-hash dedup plus an 8 MB-per-image cap
  (enforced both client- and server-side). This is the one limit without a hard
  code guard, so set an R2 storage alert in the Cloudflare dashboard
  (Notifications) if you want a heads-up as the bucket grows. Cloudflare does not
  offer a hard spend cap, so monitoring is the safety net here.
