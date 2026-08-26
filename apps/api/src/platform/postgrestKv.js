// A KvStore over Postgres, reached through PostgREST.
//
// The replacement for Cloudflare KV when self-hosting: rate-limit buckets, the
// AI answer cache, and MCP OAuth pending state, in a `(key, value, expires_at)`
// table.
//
// Through PostgREST rather than through `pg` on purpose. Every other thing this
// API reads or writes already goes over PostgREST with the service-role key, so
// this needs no new dependency, no connection pool, and no second set of
// credentials to configure — and it keeps working in the Workers runtime, which
// cannot open a raw TCP connection to Postgres at all. A direct-SQL adapter can
// be written later behind the same interface if the extra hop ever matters; for
// a store whose callers already accepted an eventually-consistent KV, it does
// not.
//
// Expiry is enforced on read rather than by the database, because PostgREST
// offers no TTL and the alternative — depending on pg_cron being installed —
// would make a self-host fail in a way that looks like a rate limiter that never
// resets. A row past its expiry reads as absent and is swept on the way past;
// see `get` below, and the periodic sweep in schema.sql for the rows nobody ever
// asks for again.

import { expiryFrom, isExpired } from './kv.js';

// The table this store lives in. Created by schema.sql alongside the hub tables.
const TABLE = 'kv_store';

/**
 * A KvStore backed by a PostgREST table.
 *
 * @param {object} config
 * @param {string} config.url      Base URL of the PostgREST server (or Supabase project).
 * @param {string} config.apiKey   The service-role key — this table is server-only.
 * @param {string} [config.table]  Defaults to 'kv_store'.
 * @param {typeof fetch} [config.fetch] Injectable for tests.
 * @returns {import('./kv.js').KvStore}
 */
export function postgrestKv(config) {
	const { url, apiKey, table = TABLE, fetch: doFetch = fetch } = config;
	const base = `${url.replace(/\/$/, '')}/rest/v1/${table}`;
	const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

	const rowUrl = (key) => `${base}?key=eq.${encodeURIComponent(key)}`;

	/** Remove a row without caring whether it was there. */
	async function remove(key) {
		await doFetch(rowUrl(key), { method: 'DELETE', headers });
	}

	return {
		async get(key) {
			const response = await doFetch(`${rowUrl(key)}&select=value,expires_at&limit=1`, { headers });
			if (!response.ok) return null;
			const rows = await response.json().catch(() => []);
			const row = Array.isArray(rows) ? rows[0] : null;
			if (!row) return null;

			// `expires_at` is a timestamptz, so it comes back as ISO-8601. A row
			// whose expiry has passed is absent as far as every caller is concerned
			// — a spent rate-limit bucket, a stale cached answer, an abandoned
			// consent flow are all things whose absence is the correct answer.
			const expiresAt = row.expires_at ? Math.floor(Date.parse(row.expires_at) / 1000) : 0;
			if (isExpired(expiresAt)) {
				// Sweep it on the way past. Best-effort and deliberately not awaited
				// for its result: the read has its answer either way, and a failed
				// delete only means the periodic sweep gets it instead.
				remove(key).catch(() => {});
				return null;
			}
			return typeof row.value === 'string' ? row.value : null;
		},

		async put(key, value, opts) {
			const expiry = expiryFrom(opts);
			const row = {
				key,
				value: String(value),
				expires_at: expiry ? new Date(expiry * 1000).toISOString() : null,
			};
			// Upsert. `merge-duplicates` is PostgREST's ON CONFLICT DO UPDATE, which
			// is what makes put() replace rather than fail on the second write to a
			// rate-limit bucket.
			const response = await doFetch(base, {
				method: 'POST',
				headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
				body: JSON.stringify(row),
			});
			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				throw new Error(`kv put ${key} failed: ${response.status} ${detail.slice(0, 200)}`);
			}
		},

		delete: remove,
	};
}
