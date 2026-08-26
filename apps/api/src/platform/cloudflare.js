// The Cloudflare implementation of the platform seam — R2 for blobs, KV for
// expiring values, `caches.default` for responses.
//
// This is what the hosted instance runs, and the reference every other host is
// written against. It is a thin renaming layer and nothing more: no fallbacks,
// no retries, no behaviour that wasn't already there when routes called the
// bindings directly. Anything cleverer belongs in the route, where it can be
// tested once for every host rather than once per host.

import { normalizeMetadata, deleteKeys } from './blobs.js';

/**
 * Normalise an R2 head/get result into the BlobHead fields. R2 splits an
 * object's metadata three ways — `httpMetadata` for the headers it will serve,
 * `customMetadata` for ours, `httpEtag` for the quoted ETag — and this is the
 * one place that knows those names.
 *
 * @param {import('@cloudflare/workers-types').R2Object} object
 */
function headOf(object) {
	return {
		key: object.key,
		contentType: object.httpMetadata?.contentType || '',
		etag: object.httpEtag || '',
		metadata: object.customMetadata || {},
		size: object.size || 0,
	};
}

/**
 * Wrap an R2 bucket binding as a BlobStore.
 * @param {import('@cloudflare/workers-types').R2Bucket} bucket
 * @returns {import('./blobs.js').BlobStore}
 */
export function r2Blobs(bucket) {
	return {
		async head(key) {
			const object = await bucket.head(key);
			return object ? headOf(object) : null;
		},

		async get(key) {
			const object = await bucket.get(key);
			if (!object) return null;
			return {
				...headOf(object),
				body: object.body,
				bytes: async () => new Uint8Array(await object.arrayBuffer()),
				text: () => object.text(),
				json: () => object.json(),
			};
		},

		async put(key, bytes, opts) {
			await bucket.put(key, bytes, {
				httpMetadata: { contentType: opts?.contentType || 'application/octet-stream' },
				customMetadata: normalizeMetadata(opts?.metadata),
			});
		},

		async delete(key) {
			const keys = deleteKeys(key);
			if (keys.length === 0) return;
			// R2's delete takes either form, but pass the array only when there is
			// more than one so a single delete stays a single-key operation.
			await bucket.delete(keys.length === 1 ? keys[0] : keys);
		},

		async list(opts) {
			// `include: ['httpMetadata']` is what makes the listing carry each
			// object's content type — without it R2 returns keys and sizes only, and
			// the WEBP backfill would need a get() per object just to decide whether
			// to skip it.
			const listing = await bucket.list({
				limit: opts?.limit,
				cursor: opts?.cursor || undefined,
				include: ['httpMetadata'],
			});
			return {
				objects: listing.objects.map(headOf),
				cursor: listing.truncated ? listing.cursor : '',
				truncated: Boolean(listing.truncated),
			};
		},
	};
}

/**
 * Wrap a KV namespace binding as a KvStore.
 * @param {import('@cloudflare/workers-types').KVNamespace} namespace
 * @returns {import('./kv.js').KvStore}
 */
export function kvStore(namespace) {
	return {
		get: (key) => namespace.get(key),
		put: async (key, value, opts) => {
			// KV rejects an expirationTtl below 60s outright, and every TTL this API
			// sets is comfortably above that — so pass it straight through and let a
			// mistake surface rather than silently rounding it up.
			await namespace.put(key, value, opts?.expirationTtl ? { expirationTtl: opts.expirationTtl } : undefined);
		},
		delete: (key) => namespace.delete(key),
	};
}

/**
 * `caches.default`, keyed by URL string.
 *
 * The Cache API keys by Request and only ever caches GETs, so each method turns
 * the caller's key back into the GET Request that Cloudflare wants. Every method
 * is best-effort — a cache error must not fail the request the handler is
 * actually serving.
 *
 * @returns {import('./cache.js').ResponseCache}
 */
export function edgeCache() {
	const keyOf = (key) => new Request(key, { method: 'GET' });
	return {
		async match(key) {
			try {
				return (await caches.default.match(keyOf(key))) || null;
			} catch (e) {
				return null;
			}
		},
		async put(key, response) {
			try {
				await caches.default.put(keyOf(key), response);
			} catch (e) {
				// An uncacheable response (or a full cache) is not this caller's problem.
			}
		},
		async delete(key) {
			try {
				await caches.default.delete(keyOf(key));
			} catch (e) {
				// Best-effort purge; a stale entry expires on its own.
			}
		},
	};
}

/**
 * The platform services backed by this Worker's bindings.
 *
 * Each store is null when its binding is absent, which is how a preview
 * deployment without a bucket still serves everything that doesn't need one —
 * the same check the routes were already making against `env.IMAGES` directly.
 *
 * @param {object} env
 */
export function cloudflarePlatform(env) {
	return {
		images: env?.IMAGES ? r2Blobs(env.IMAGES) : null,
		lessonGit: env?.LESSON_GIT ? r2Blobs(env.LESSON_GIT) : null,
		rateLimit: env?.RATE_LIMIT_KV ? kvStore(env.RATE_LIMIT_KV) : null,
		oauthState: env?.OAUTH_KV ? kvStore(env.OAUTH_KV) : null,
		cache: edgeCache(),
		// Cloudflare's own header, set by the edge and not forgeable by the client
		// (it overwrites whatever arrived). Deliberately no x-forwarded-for
		// fallback here: on this host that header IS client-controlled, and the IP
		// is used for bans.
		clientIp: (request) => request.headers.get('cf-connecting-ip') || '',
	};
}
