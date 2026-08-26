---
title: The platform seam
---

# The platform seam

The hosted instance of Spelling Creator runs on Cloudflare, and will keep doing
so. But almost nothing in `apps/api` needs to: the lesson hub talks to Postgres
over PostgREST, identity comes from GoTrue, and both are ordinary HTTP APIs with
open-source servers behind them.

What _was_ Cloudflare-shaped is where everything else lives — lesson images and
packed lesson histories in R2, rate-limit buckets in KV, cached renders in
`caches.default`. Those three had no standard equivalent, and route code called
their bindings directly.

The **platform seam** (`apps/api/src/platform/`) is the layer that fixed that. It
names the handful of operations this API actually performs against each of them,
so a handler can ask for "the image store" rather than for `env.IMAGES`.

## What it covers

```
platform(env) -> {
  images,      BlobStore | null   lesson images, keyed by content hash
  lessonGit,   BlobStore | null   lesson history packfiles
  rateLimit,   KvStore   | null   rate-limit buckets + the AI answer cache
  oauthState,  KvStore   | null   short-lived MCP OAuth authorization state
  cache,       ResponseCache      HTTP response cache (never null; may no-op)
  clientIp(request) -> string
}
```

Handlers reach for these through the named helpers rather than the object:

```js
import {
  imageStore,
  rateLimitStore,
  responseCache,
} from "../platform/index.js";

const images = imageStore(env);
if (!images) return textResponse("Image store is not configured.", 500, cors);
const object = await images.get(hash);
```

A store is `null` when its backing service isn't configured — which is how a
preview deployment without a bucket still serves every route that doesn't need
one. `cache` is the exception and is never null, because "don't cache" is always
a valid answer; a host with nowhere to cache returns the no-op cache.

## The three interfaces

Each is deliberately tiny, and each is the intersection of what the hosted
services and their self-hostable counterparts both offer.

**`BlobStore`** — `head`, `get`, `put`, `delete`, `list`. No multipart, no
conditional writes, no presigning, no ACLs. Both stores here are
content-addressed or author-owned and written whole. The shapes are normalised
away from R2's vocabulary: route code sees `contentType`, `etag` and `metadata`,
never `httpMetadata`, `httpEtag` or `customMetadata`.

**`KvStore`** — `get`, `put`, `delete`, string values, one `expirationTtl`
option. Deliberately no list, no atomic increment, no compare-and-set: the rate
limiters are read-modify-write token buckets that tolerate a lost update, and
nothing else mutates a shared key, so an adapter never needs a transaction.

**`ResponseCache`** — `match`, `put`, `delete`, keyed by URL **string**.
Cloudflare's Cache API keys by `Request`, which is a Workers shape; a string key
is something any host can implement, including by not implementing it at all.
Every method is best-effort — a cache that fails must change how much work a
handler did, never what it returned.

## The conformance suite

A seam is only worth having if the implementations behind it are genuinely
interchangeable, so the contract is executable rather than documentary.
`src/platform/conformance.js` exports `testBlobStore` and `testKvStore`; each
adapter's test file runs them against a live instance of itself, and passing them
is what "implements `BlobStore`" means.

`src/platform/cloudflare.test.js` runs both suites against real R2 and KV inside
workerd (Miniflare provides a `TEST_BLOBS` bucket and a `TEST_KV` namespace for
exactly this). Those results are the reference: whatever the suite asserts there
is what any other adapter has to reproduce.

The cases it pins down are the ones that would otherwise diverge quietly — a
missing key reading as `null` rather than throwing, metadata surviving a round
trip, `delete([])` being a no-op rather than an error or a bulk wipe, `truncated`
and `cursor` agreeing on the last page of a listing.

## The S3 blob store

`src/platform/s3.js` is a `BlobStore` over any S3-compatible object store —
MinIO, Garage, Ceph RGW, SeaweedFS, Backblaze B2, or AWS itself.

```js
import { s3Blobs } from "./platform/s3.js";

const images = s3Blobs({
  endpoint: "http://minio:9000",
  bucket: "spelling-creator-images",
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  region: "us-east-1", // what MinIO and Garage expect
});
```

It is built on `fetch` and a hand-written SigV4 signer (`src/platform/sigv4.js`)
rather than on `@aws-sdk/client-s3`. The SDK is tens of megabytes and assumes
Node; signing is a page of well-specified arithmetic that runs unchanged in
workerd, in Node, and anywhere else with `fetch` and `crypto.subtle`. Only five
operations are needed and none of them is complicated.

Signing is the kind of code that is either exactly right or quietly wrong for a
subset of inputs — a key with a space in it, a query string in the wrong order.
So `sigv4.test.js` checks it against AWS's own published examples, asserting the
canonical request and the string-to-sign as well as the final signature, which
localises a mistake to one line instead of one digest.

Two places where S3 and R2 genuinely differ, both absorbed by the adapter:

- **Metadata is ASCII.** `x-amz-meta-*` headers are ASCII by specification, where
  R2's `customMetadata` takes arbitrary strings. Values are percent-encoded on
  the way out and decoded on the way in, so the round trip is lossless without
  depending on a server tolerating bytes it was never promised.
- **Listings carry no content type.** A `ListObjectsV2` response has keys, sizes
  and ETags but not content types, where R2's listing has them. Rather than
  weaken the contract — the WEBP backfill filters on content type straight off
  the listing — the adapter pays with a `HEAD` per listed object. The only caller
  pages in batches of at most 50 and then reads and rewrites every object it
  didn't skip, so the extra request is small next to the work it saves.

**Addressing** defaults to path style (`http://host:9000/bucket/key`), which is
what a self-hosted MinIO or Garage serves without wildcard DNS. Pass
`forcePathStyle: false` for AWS-style virtual hosts.

**Bulk deletes** are issued as parallel `DELETE`s, eight at a time, rather than
through S3's `DeleteObjects` POST. That API is the one smaller S3
implementations most often lack, and building and signing an XML body would save
nothing at the sizes this sees.

`s3.test.js` runs the shared conformance suite against an in-process S3 built
over a `Map`. A stub rather than a container in CI — and a stub can be stricter
than a real server: this one rejects an unsigned request, so every test also
asserts that the request was signed, and it stores metadata as the raw header
bytes it received, so the encoding round trip is exercised rather than assumed.

## The Postgres key-value store

`src/platform/postgrestKv.js` is a `KvStore` over a `(key, value, expires_at)`
table, reached through PostgREST.

```js
import { postgrestKv } from "./platform/postgrestKv.js";

const kv = postgrestKv({
  url: process.env.SUPABASE_URL, // or any PostgREST server
  apiKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
```

Through PostgREST rather than through `pg` on purpose. Everything else this API
reads or writes already goes over PostgREST with the service-role key, so this
needs no new dependency, no connection pool and no second set of credentials —
and it keeps working in the Workers runtime, which cannot open a raw TCP
connection to Postgres at all. A direct-SQL adapter can be written later behind
the same interface if the extra hop ever matters; for a store whose callers
already accepted an eventually-consistent KV, it does not.

The table is in `apps/api/schema.sql`. Creating it on the hosted instance too is
harmless — nothing writes to it there.

**Expiry is enforced on read**, not by the database. PostgREST offers no TTL, and
depending on `pg_cron` being installed would make a self-host fail in a way that
looks like a rate limiter that never resets. A row past its expiry reads as
absent and is swept on the way past, so correctness never depends on the periodic
sweep running; that only reclaims rows nobody asks for again. `schema.sql`
carries the `pg_cron` snippet for instances that can run it.

Nothing in the table is authoritative — every row is small, short-lived, and has
an expiry past which its absence is the right answer. That is what lets it be an
ordinary table with no locking and no transactions: the rate limiters are
read-modify-write token buckets that tolerate a lost update, and the worst one
costs is a single extra request served.

A failed read returns `null` rather than throwing, so an unreachable database
degrades to a cache miss instead of taking the route down with it. A failed
_write_ does throw — silently not recording a rate-limit charge is not a
degradation, it is a hole.

## Adding a host

Write one module that returns the shape above, and put it on `env.PLATFORM`
before the first request. That is the whole switch — there is no registry and no
detection, because a host always knows what it is. The Worker is the only case
that can't say so, and it's the fallback.

```js
// A non-Cloudflare entry point, once at startup:
env.PLATFORM = {
  images: s3Blobs({ endpoint, bucket: "spelling-creator-images", ...creds }),
  lessonGit: s3Blobs({ endpoint, bucket: "spelling-creator-git", ...creds }),
  rateLimit: postgresKv(pool),
  oauthState: postgresKv(pool),
  cache: noopCache,
  clientIp: (request) => request.headers.get("x-forwarded-for") || "",
};
```

Then run the conformance suites against each new adapter. `cloudflare.js` is the
reference implementation and is a thin renaming layer by design: no fallbacks, no
retries, no behaviour that wasn't already in the route. Anything cleverer belongs
in the route, where it can be tested once for every host rather than once per
host.

## What this is not

The seam covers storage, not compute. Durable Objects (live collaboration and the
remote MCP session), Browser Rendering (crawler prerendering and og-image
screenshots) and Workers AI are all still Cloudflare-specific and are not behind
it.

The rich-text sanitizer used to be on that list — it was built on `HTMLRewriter`
— and is no longer: it parses with parse5, which runs in every runtime. That one
was solved by removing the coupling rather than by abstracting over it, which is
the better answer whenever it is available. See
[Rich text](../web-app/rich-text.md).

Nor does it make the API run on Node today — the entry point is still a Worker.
It removes the part of the coupling that was spread across every route, so that
what remains is concentrated in a few named places.
