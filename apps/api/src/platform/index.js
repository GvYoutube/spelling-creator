// The platform seam — the boundary between this API's logic and the services it
// stores things in.
//
// Everything the Worker keeps outside of Postgres lives behind one of three tiny
// interfaces defined here: a blob store, a key-value store with expiry, and a
// response cache. Route code asks for them *by role* ("the image store", "the
// rate limiter") rather than by binding name, so the same handlers run against
// Cloudflare's R2/KV/Cache API or against S3-compatible object storage and a
// Postgres table without knowing which.
//
// This exists for self-hosting. The hosted instance runs on Cloudflare and will
// keep doing so; but R2, KV and `caches.default` are the only pieces of this API
// with no standard equivalent, and each is used through a handful of methods.
// Naming that handful is the difference between "portable" and "rewrite".
//
// Adding a host means writing one module that returns the shape below — see
// cloudflare.js for the reference implementation, and the interface docs in
// blobs.js / kv.js / cache.js for what each method must do.
//
//   platform(env) -> {
//     images,      BlobStore | null   lesson images, keyed by content hash
//     lessonGit,   BlobStore | null   lesson history packfiles
//     rateLimit,   KvStore   | null   rate-limit buckets + the AI answer cache
//     oauthState,  KvStore   | null   short-lived MCP OAuth authorization state
//     cache,       ResponseCache      HTTP response cache (never null; may no-op)
//     clientIp(request) -> string
//   }
//
// A store is null when its backing service isn't configured, which callers
// already check for — an instance without an image bucket serves everything
// else. `cache` is the exception: a host with no cache returns the no-op cache
// (see cache.js), because "don't cache" is always a valid answer.

import { cloudflarePlatform } from './cloudflare.js';

// Memoised per `env` object. The adapters hold no per-request state, and the
// runtime hands the same `env` to every request, so building them once keeps
// this seam free rather than allocating a set of wrappers per call site.
const built = new WeakMap();

/**
 * The platform services for this request's environment.
 *
 * A host that isn't Cloudflare builds its own set once at startup and puts it on
 * `env.PLATFORM`; anything else falls back to the Cloudflare bindings. That's
 * the whole switch — there is deliberately no registry or detection, because a
 * host always knows what it is and the Worker is the only case that can't say so
 * (its `env` arrives from the runtime, already populated).
 *
 * @param {object} env
 * @returns {{
 *   images: import('./blobs.js').BlobStore | null,
 *   lessonGit: import('./blobs.js').BlobStore | null,
 *   rateLimit: import('./kv.js').KvStore | null,
 *   oauthState: import('./kv.js').KvStore | null,
 *   cache: import('./cache.js').ResponseCache,
 *   clientIp: (request: Request) => string,
 * }}
 */
export function platform(env) {
	if (env && env.PLATFORM) return env.PLATFORM;
	let p = built.get(env);
	if (!p) {
		p = cloudflarePlatform(env);
		built.set(env, p);
	}
	return p;
}

/** The lesson-image blob store, or null when this host has none. */
export const imageStore = (env) => platform(env).images;

/** The lesson-history blob store, or null when this host has none. */
export const gitStore = (env) => platform(env).lessonGit;

/**
 * The rate-limit/AI-cache key-value store, or null when unconfigured. Named for
 * what it holds rather than for the binding: the AI answer cache shares it
 * because both are short-lived, expiring, non-authoritative entries.
 */
export const rateLimitStore = (env) => platform(env).rateLimit;

/** The MCP OAuth pending-authorization store, or null when unconfigured. */
export const oauthStateStore = (env) => platform(env).oauthState;

/** This host's HTTP response cache. Never null — see the no-op cache. */
export const responseCache = (env) => platform(env).cache;

/**
 * The client IP a request arrived from, however this host reports it. Recorded
 * on new content so an admin can later ban that address, and checked against
 * `banned_ips`.
 */
export const clientIp = (env, request) => platform(env).clientIp(request);
