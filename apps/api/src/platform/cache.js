// ResponseCache — the HTTP response cache in front of the expensive reads.
//
// Three things use it: immutable image bytes (so a public lesson view doesn't
// cost an object-store read per visitor), crawler prerender snapshots, and
// og-image screenshots (both of which cost a headless browser). All three are
// keyed by a URL string and hold a whole Response.
//
// Cloudflare's `caches.default` keys entries by `Request`, which is a Workers
// shape — so this interface keys by string instead, and the Cloudflare adapter
// builds the Request itself. That's the only reason this interface exists rather
// than route code touching `caches.default`: a string key is something any host
// can implement, including by not caching at all.
//
// Every method is best-effort. A cache that fails, or that stores nothing, must
// never change what a handler returns — only how much work it did to get there.
//
// This file documents the interface and provides the no-op implementation.

/**
 * @typedef {object} ResponseCache
 * @property {(key: string) => Promise<Response | null>} match
 *   The cached response for this key, or null on a miss.
 * @property {(key: string, response: Response) => Promise<void>} put
 *   Cache a response. The caller passes a clone it no longer needs; honouring
 *   the response's own Cache-Control is the adapter's business.
 * @property {(key: string) => Promise<void>} delete
 *   Drop a cached entry. Deleting an absent key is not an error.
 */

/**
 * A cache that stores nothing and reports every lookup as a miss.
 *
 * This is the correct default for a self-hosted instance, which almost always
 * has a reverse proxy (Caddy, nginx, Varnish) in front of it doing this job
 * properly, with a shared store and eviction — where an in-process Map would
 * hold a copy per worker process and grow without bound. Handlers already treat
 * a miss as normal, so caching nothing is a complete implementation.
 *
 * @type {ResponseCache}
 */
export const noopCache = {
	async match() {
		return null;
	},
	async put() {},
	async delete() {},
};
