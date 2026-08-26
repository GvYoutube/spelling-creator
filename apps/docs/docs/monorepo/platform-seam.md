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

## Adding a host

Write one module that returns the shape above, and put it on `env.PLATFORM`
before the first request. That is the whole switch — there is no registry and no
detection, because a host always knows what it is. The Worker is the only case
that can't say so, and it's the fallback.

```js
// A non-Cloudflare entry point, once at startup:
env.PLATFORM = {
  images: s3Blobs(client, "spelling-creator-images"),
  lessonGit: s3Blobs(client, "spelling-creator-git"),
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
screenshots), Workers AI and `HTMLRewriter` are all still Cloudflare-specific and
are not behind it.

Nor does it make the API run on Node today — the entry point is still a Worker.
It removes the part of the coupling that was spread across every route, so that
what remains is concentrated in a few named places.
