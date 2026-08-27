// The Postgres/PostgREST key-value store, run against an in-process PostgREST.
//
// As with the S3 adapter, the shared conformance suite is the point: this has to
// answer the way Cloudflare KV does. The stub below implements just the slice of
// PostgREST this store uses — a filtered select, an upsert, a delete — and is
// strict about the credentials, so a store that forgot to send the service-role
// key fails here rather than in someone's deployment.
//
// The expiry tests are adapter-specific rather than part of the suite, because
// the suite can't have them: Cloudflare KV enforces a 60-second minimum TTL, so
// asserting real expiry there would mean a test that sleeps for a minute. This
// store enforces expiry itself, in code, which is exactly the thing worth
// testing.

import { describe, expect, it } from 'vitest';

import { testKvStore } from './conformance.js';
import { postgrestKv } from './postgrestKv.js';

const API_KEY = 'service-role-key';

/**
 * An in-memory PostgREST serving one `kv_store` table.
 *
 * @returns {{ fetch: typeof fetch, rows: Map<string, object>, requests: object[] }}
 */
function fakePostgrest() {
	/** @type {Map<string, { key: string, value: string, expires_at: string | null }>} */
	const rows = new Map();
	const requests = [];

	/** The `key=eq.<value>` filter, decoded, or null when the request has none. */
	function keyFilter(url) {
		const raw = url.searchParams.get('key') || '';
		return raw.startsWith('eq.') ? raw.slice(3) : null;
	}

	async function handle(input, init = {}) {
		const url = new URL(input);
		const method = (init.method || 'GET').toUpperCase();
		const headers = new Headers(init.headers);
		requests.push({ method, url: url.toString() });

		// Strict on purpose. This table is server-only — it holds OAuth state — so
		// an adapter that reached it without the service-role key would be a real
		// finding, not a test-harness detail.
		if (headers.get('apikey') !== API_KEY || headers.get('authorization') !== `Bearer ${API_KEY}`) {
			return new Response(JSON.stringify({ message: 'No API key found in request' }), { status: 401 });
		}
		if (!url.pathname.endsWith('/rest/v1/kv_store')) {
			return new Response(JSON.stringify({ message: 'relation does not exist' }), { status: 404 });
		}

		if (method === 'POST') {
			const body = JSON.parse(init.body);
			// PostgREST only upserts when asked; without the Prefer header a repeat
			// key is a 409, and a rate-limit bucket would stop updating after its
			// first write.
			if (!(headers.get('prefer') || '').includes('resolution=merge-duplicates') && rows.has(body.key)) {
				return new Response(JSON.stringify({ code: '23505', message: 'duplicate key value' }), { status: 409 });
			}
			rows.set(body.key, { key: body.key, value: body.value, expires_at: body.expires_at ?? null });
			return new Response(null, { status: 201 });
		}

		const key = keyFilter(url);
		if (method === 'DELETE') {
			// PostgREST deletes what the filters match, so an `expires_at=eq.` on the
			// request narrows it to the exact row that was read — which is how the
			// expiry sweep avoids deleting a replacement.
			const expiry = url.searchParams.get('expires_at') || '';
			const expected = expiry.startsWith('eq.') ? expiry.slice(3) : null;
			const row = key !== null ? rows.get(key) : null;
			if (row && (expected === null || row.expires_at === expected)) rows.delete(key);
			return new Response(null, { status: 204 });
		}

		const found = key !== null ? rows.get(key) : null;
		return new Response(JSON.stringify(found ? [found] : []), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}

	return { fetch: handle, rows, requests };
}

const storeOver = (server) => postgrestKv({ url: 'https://db.test', apiKey: API_KEY, fetch: server.fetch });

const conformanceServer = fakePostgrest();

testKvStore({
	store: () => storeOver(conformanceServer),
	prefix: 'conformance:',
	vitest: { describe, expect, it },
});

describe('postgrestKv expiry', () => {
	it('reads a value back before it expires', async () => {
		const store = storeOver(fakePostgrest());
		await store.put('fresh', 'value', { expirationTtl: 3600 });
		expect(await store.get('fresh')).toBe('value');
	});

	it('reports an expired row as absent', async () => {
		// Written straight into the table rather than through put(), because a TTL
		// short enough to expire during a test is one no caller ever sets.
		const server = fakePostgrest();
		server.rows.set('stale', {
			key: 'stale',
			value: 'gone',
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		expect(await storeOver(server).get('stale')).toBe(null);
	});

	it('sweeps an expired row on the way past', async () => {
		const server = fakePostgrest();
		server.rows.set('stale', {
			key: 'stale',
			value: 'gone',
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		await storeOver(server).get('stale');
		// The delete is fire-and-forget, so let the microtask queue drain first.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(server.rows.has('stale')).toBe(false);
	});

	it('does not sweep a row that was written while the stale one was being read', async () => {
		// The sweep is fire-and-forget, so a put() can land between the read and the
		// delete. Without matching on the expiry that was read, the sweep of the
		// spent bucket would take the fresh one with it — and the next request would
		// find no bucket at all and start a new rate-limit window.
		const server = fakePostgrest();
		const stale = new Date(Date.now() - 1000).toISOString();
		server.rows.set('bucket', { key: 'bucket', value: 'spent', expires_at: stale });

		// Hold the sweep's DELETE open until the replacement has been written.
		let release;
		const held = new Promise((resolve) => {
			release = resolve;
		});
		const slow = {
			fetch: async (input, init = {}) => {
				if ((init.method || 'GET').toUpperCase() === 'DELETE') await held;
				return await server.fetch(input, init);
			},
		};
		const store = storeOver(slow);

		expect(await store.get('bucket')).toBe(null);
		await store.put('bucket', 'fresh', { expirationTtl: 60 });
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(await store.get('bucket')).toBe('fresh');
	});

	it('keeps a row with no expiry indefinitely', async () => {
		const server = fakePostgrest();
		const store = storeOver(server);
		await store.put('forever', 'kept');
		expect(server.rows.get('forever').expires_at).toBe(null);
		expect(await store.get('forever')).toBe('kept');
	});

	it('writes the expiry as a timestamp the database can sweep on', async () => {
		// The periodic sweep in schema.sql compares this column to now(), so it has
		// to be a real timestamptz rather than, say, an epoch integer.
		const server = fakePostgrest();
		await storeOver(server).put('ttl', 'v', { expirationTtl: 120 });
		const written = Date.parse(server.rows.get('ttl').expires_at);
		expect(Number.isNaN(written)).toBe(false);
		expect(written).toBeGreaterThan(Date.now());
		expect(written).toBeLessThanOrEqual(Date.now() + 120_000);
	});
});

describe('postgrestKv requests', () => {
	it('upserts rather than inserting', async () => {
		// The second write to a rate-limit bucket is the common case, not the edge
		// case — an insert-only put() would break the limiter on its second call.
		const server = fakePostgrest();
		const store = storeOver(server);
		await store.put('bucket', '1');
		await store.put('bucket', '2');
		expect(await store.get('bucket')).toBe('2');
	});

	it('reports a failed write rather than swallowing it', async () => {
		const store = postgrestKv({
			url: 'https://db.test',
			apiKey: 'wrong-key',
			fetch: fakePostgrest().fetch,
		});
		await expect(store.put('k', 'v')).rejects.toThrow(/401/);
	});

	it('returns null rather than throwing when a read fails', async () => {
		// A rate limiter that throws on an unreachable database would take the
		// whole route down with it; treating the read as a miss degrades instead.
		const store = postgrestKv({
			url: 'https://db.test',
			apiKey: 'wrong-key',
			fetch: fakePostgrest().fetch,
		});
		expect(await store.get('k')).toBe(null);
	});

	it('reports a failed delete rather than claiming the key is gone', async () => {
		// Deleting an absent key is a no-op by contract, but a refused DELETE means
		// the row may well still be there — and the caller deleting a consumed OAuth
		// authorization is entitled to know that.
		const store = postgrestKv({
			url: 'https://db.test',
			apiKey: 'wrong-key',
			fetch: fakePostgrest().fetch,
		});
		await expect(store.delete('k')).rejects.toThrow(/401/);
	});

	it('escapes a key that would otherwise break the filter', async () => {
		const server = fakePostgrest();
		const store = storeOver(server);
		// Cache keys are hashes, but OAuth state keys are prefixed and a filter
		// built by concatenation is worth pinning down regardless.
		await store.put('mcp-oauth-req:a&b=c', 'state');
		expect(await store.get('mcp-oauth-req:a&b=c')).toBe('state');
	});
});
