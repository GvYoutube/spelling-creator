---
title: Lesson images (binary, R2 + IndexedDB)
sidebar_position: 3
---

# Lesson images (binary, R2 + IndexedDB)

Lesson images are stored as binary, keyed by their SHA-256 content hash — not as
base64 inside the lesson doc. Locally they live as blobs in IndexedDB (so large
drafts aren't capped by `localStorage`'s ~5 MB quota); in the cloud they live in
an R2 bucket. The lesson doc only references images by hash.

Worker endpoints (`apps/api/src/index.js`):

- `GET /images/:hash` — public; serves the image bytes from R2 (immutable cache),
  with whatever content type the stored object has.
- `PUT /images/:hash` — authenticated (Supabase JWT); verifies the body hashes to
  `:hash` before storing. Called on save/publish to upload locally-drafted images.
  On the way in, the Worker re-compresses raster images to **WEBP**
  (`convertImageToWebp` in `apps/api/src/imageConvert.js`), falling back to the
  original bytes for formats it can't decode or when the WEBP isn't smaller. The
  key is still the original content hash, so dedup and references are unaffected.

The browser also tries to do this conversion itself before an image ever reaches
the Worker: `readImageFile` (`apps/web/src/lib/image.js`) re-encodes PNG/JPEG
picks to WEBP on a canvas (same quality target, same keep-whichever-is-smaller
rule) while it's already decoding the file to measure its dimensions. This is
purely an optimization — it saves upload bandwidth and R2 conversion work for
the common case — not a correctness requirement: browsers without WEBP canvas
encoding, GIF/SVG (skipped client-side on purpose, same as server-side), and any
client that skips or fails the step all still land on the Worker as their
original raster type, which converts them exactly as described above.

Setup:

```bash
# Create the R2 bucket the IMAGES binding points at (see apps/api/wrangler.jsonc).
wrangler r2 bucket create spelling-creator-images

# Secret for the one-time backfill endpoint (below).
wrangler secret put ADMIN_MIGRATE_TOKEN
```

## Migrating existing lessons

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

A second, separate backfill **re-compresses images already in R2** to WEBP — for
objects uploaded before the `PUT` handler started converting. It's gated by the
same `ADMIN_MIGRATE_TOKEN` and pages through the bucket with R2's list cursor,
overwriting each PNG/JPEG object at the same key (only when the WEBP is smaller).
It's idempotent — already-WEBP and untranscodable objects are skipped:

```bash
# Repeat, passing the returned nextCursor each time, until nextCursor is null.
curl -X POST https://<worker-host>/admin/backfill-webp \
  -H "X-Admin-Token: $ADMIN_MIGRATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit": 10}'
```

## Staying within R2's free tier

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
  (`MAX_IMAGE_BYTES` in `apps/api/src/lib/images.js`, enforced server-side only —
  there is no client-side size check). This is the one limit without a hard
  code guard, so set an R2 storage alert in the Cloudflare dashboard
  (Notifications) if you want a heads-up as the bucket grows. Cloudflare does not
  offer a hard spend cap, so monitoring is the safety net here.
