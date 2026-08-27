// The behaviour every platform adapter has to have, written once.
//
// A seam is only worth having if the implementations behind it are actually
// interchangeable, and "actually" is not something a JSDoc typedef can enforce.
// So the contract is executable: each adapter's test file calls the suites below
// against a live instance of itself, and passing them is what "implements
// BlobStore" means.
//
// This exists mostly for the adapters that don't exist yet. When the S3 store
// lands, the question that matters is not whether it works but whether it works
// *the same way* — whether a missing key is null rather than a throw, whether
// metadata survives a round trip, whether deleting nothing is a no-op. Those are
// exactly the differences that would otherwise surface as a self-hosted instance
// behaving subtly unlike the hosted one, months later, in someone else's data.
//
// Each suite is given a factory rather than a store, so it can start from a
// clean namespace, and a `prefix` it should confine itself to, so a run against
// a real bucket doesn't disturb anything else living there.

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Assert a BlobStore behaves the way route code assumes it does.
 *
 * @param {object} harness
 * @param {() => import('./blobs.js').BlobStore} harness.store  A fresh handle to the store under test.
 * @param {string} harness.prefix  Key prefix this run may write under.
 * @param {object} harness.vitest  The `{ describe, it, expect }` trio from the runner.
 */
export function testBlobStore({ store, prefix, vitest: { describe, it, expect } }) {
	const key = (name) => `${prefix}${name}`;

	describe('BlobStore contract', () => {
		it('reports a missing object as null rather than throwing', async () => {
			const s = store();
			expect(await s.get(key('absent'))).toBe(null);
			expect(await s.head(key('absent'))).toBe(null);
		});

		it('round-trips bytes, content type and metadata', async () => {
			const s = store();
			const bytes = enc.encode('hello history');
			await s.put(key('round-trip'), bytes, {
				contentType: 'application/x-git-packfile',
				metadata: { head: 'a'.repeat(40) },
			});

			const object = await s.get(key('round-trip'));
			expect(object).not.toBe(null);
			expect(object.contentType).toBe('application/x-git-packfile');
			// `metadata` is always an object — the pack route reads `.head` off it
			// without a guard, so an adapter returning undefined would throw there.
			expect(object.metadata.head).toBe('a'.repeat(40));
			expect(dec.decode(await object.bytes())).toBe('hello history');
		});

		it('exposes the same metadata from head() as from get()', async () => {
			const s = store();
			await s.put(key('head-parity'), enc.encode('x'), {
				contentType: 'image/webp',
				metadata: { note: 'kept' },
			});
			const head = await s.head(key('head-parity'));
			expect(head.contentType).toBe('image/webp');
			expect(head.metadata.note).toBe('kept');
			expect(head.key).toBe(key('head-parity'));
		});

		it('reads a stored object as text and as JSON', async () => {
			const s = store();
			await s.put(key('refs.json'), JSON.stringify({ head: 'b'.repeat(40) }), {
				contentType: 'application/json',
			});
			expect(await (await s.get(key('refs.json'))).json()).toEqual({ head: 'b'.repeat(40) });
			expect(await (await s.get(key('refs.json'))).text()).toContain('bbbb');
		});

		it('streams an object body', async () => {
			const s = store();
			await s.put(key('streamed'), enc.encode('body bytes'), { contentType: 'text/plain' });
			// The image route hands `body` straight to a Response without buffering,
			// so it has to be a web stream rather than a Node one or a buffer.
			const object = await s.get(key('streamed'));
			expect(await new Response(object.body).text()).toBe('body bytes');
		});

		it('replaces an object in place', async () => {
			const s = store();
			await s.put(key('replaced'), enc.encode('first'), { contentType: 'text/plain' });
			await s.put(key('replaced'), enc.encode('second'), { contentType: 'text/plain' });
			expect(dec.decode(await (await s.get(key('replaced'))).bytes())).toBe('second');
		});

		it('stores a value with no metadata as an empty map', async () => {
			const s = store();
			await s.put(key('bare'), enc.encode('x'));
			expect((await s.get(key('bare'))).metadata).toEqual({});
		});

		it('round-trips a metadata value that is not ASCII', async () => {
			// Nothing stored today needs this — a pack's metadata is git oids and
			// branch names, and branch names are ASCII by validation. It is in the
			// contract anyway because the alternative is an adapter that mangles a
			// value nobody notices until something else starts using the field: S3
			// metadata headers are ASCII by specification, so a store over them has
			// to encode, and that is the kind of thing to settle once rather than
			// discover.
			const s = store();
			await s.put(key('unicode-meta'), enc.encode('x'), { metadata: { note: 'variación — ok' } });
			expect((await s.get(key('unicode-meta'))).metadata.note).toBe('variación — ok');
		});

		it('round-trips a key that needs escaping', async () => {
			// Keys are hashes and UUID-shaped paths today, so this is guarding the
			// seam rather than a live case — but a store whose signing or path
			// building is subtly wrong usually still works for [a-z0-9/] and fails
			// only here.
			const s = store();
			await s.put(key('odd key/with+chars~'), enc.encode('found'), { contentType: 'text/plain' });
			expect(await (await s.get(key('odd key/with+chars~'))).text()).toBe('found');
		});

		it('refuses a key with a dot segment rather than resolving it', async () => {
			// A path-based store resolves `a/../b` to `b` while an object store takes
			// it literally, so accepting one would mean the same call naming two
			// different objects depending on the host — and on the path-based host,
			// writing somewhere the caller never asked for. Every adapter refuses.
			const s = store();
			await expect(s.put(key('bad/../escape'), enc.encode('x'))).rejects.toThrow(/path segment/);
			await expect(s.get(`${prefix}../escape`)).rejects.toThrow(/path segment/);
			await expect(s.head(`${prefix}../escape`)).rejects.toThrow(/path segment/);
			await expect(s.delete([key('fine'), key('bad/./here')])).rejects.toThrow(/path segment/);
		});

		it('deletes one key, and deleting an absent key is not an error', async () => {
			const s = store();
			await s.put(key('single-delete'), enc.encode('x'));
			await s.delete(key('single-delete'));
			expect(await s.get(key('single-delete'))).toBe(null);
			await s.delete(key('single-delete'));
		});

		it('deletes several keys at once', async () => {
			const s = store();
			await s.put(key('batch-a'), enc.encode('a'));
			await s.put(key('batch-b'), enc.encode('b'));
			// The lesson-delete path passes an array built from a query, so it must
			// tolerate both a populated list and — see below — an empty one.
			await s.delete([key('batch-a'), key('batch-b')]);
			expect(await s.get(key('batch-a'))).toBe(null);
			expect(await s.get(key('batch-b'))).toBe(null);
		});

		it('treats an empty delete list as a no-op', async () => {
			// A lesson with no proposals sweeps an empty array of pull packs. An
			// adapter that passed that through to a bulk-delete API would either
			// error or, worse, act on everything.
			await store().delete([]);
		});

		it('lists objects with their content types and metadata, and pages', async () => {
			const s = store();
			await s.put(key('list-1'), enc.encode('1'), { contentType: 'image/png', metadata: { listed: 'yes' } });
			await s.put(key('list-2'), enc.encode('2'), { contentType: 'image/webp' });

			// The WEBP backfill filters on contentType straight off the listing — a
			// listing without it would make it fetch every object to decide.
			const all = await s.list({ limit: 100 });
			const mine = all.objects.filter((o) => o.key.startsWith(prefix));
			expect(mine.length).toBeGreaterThanOrEqual(2);
			expect(mine.every((o) => typeof o.contentType === 'string')).toBe(true);
			// BlobHead promises metadata everywhere it appears, and a listing is
			// where a host is most tempted to leave it out: R2 omits it unless the
			// listing asks, and the S3 adapter gets it for free from its per-object
			// HEAD. A caller filtering a listing on metadata must not have to know
			// which host it is talking to.
			expect(mine.every((o) => o.metadata && typeof o.metadata === 'object')).toBe(true);
			expect(mine.find((o) => o.key === key('list-1')).metadata.listed).toBe('yes');

			const page = await s.list({ limit: 1 });
			expect(page.objects.length).toBe(1);
			expect(page.truncated).toBe(true);
			expect(page.cursor).not.toBe('');

			// The backfill loops until the cursor comes back null, which it derives
			// from `truncated` — so the two have to agree on the last page.
			const last = await s.list({ limit: 1000 });
			expect(last.truncated).toBe(false);
			expect(last.cursor).toBe('');
		});
	});
}

/**
 * Assert a KvStore behaves the way the rate limiters and caches assume it does.
 *
 * @param {object} harness
 * @param {() => import('./kv.js').KvStore} harness.store
 * @param {string} harness.prefix
 * @param {object} harness.vitest
 */
export function testKvStore({ store, prefix, vitest: { describe, it, expect } }) {
	const key = (name) => `${prefix}${name}`;

	describe('KvStore contract', () => {
		it('reports a missing key as null rather than throwing', async () => {
			expect(await store().get(key('absent'))).toBe(null);
		});

		it('round-trips a string value', async () => {
			const s = store();
			// Every caller stores JSON or a decimal count and parses what comes back,
			// so the value has to survive verbatim — no coercion, no trimming.
			await s.put(key('bucket'), JSON.stringify({ tokens: 4, last: 1 }));
			expect(JSON.parse(await s.get(key('bucket')))).toEqual({ tokens: 4, last: 1 });
		});

		it('replaces a value in place', async () => {
			const s = store();
			await s.put(key('counter'), '1');
			await s.put(key('counter'), '2');
			expect(await s.get(key('counter'))).toBe('2');
		});

		it('accepts a TTL', async () => {
			// Not asserting expiry itself — that would mean sleeping past a store's
			// minimum TTL (60s on Cloudflare KV). What matters here is that the
			// option is accepted and doesn't change what is read back.
			const s = store();
			await s.put(key('ttl'), 'kept', { expirationTtl: 120 });
			expect(await s.get(key('ttl'))).toBe('kept');
		});

		it('deletes a key, and deleting an absent key is not an error', async () => {
			const s = store();
			await s.put(key('doomed'), 'x');
			await s.delete(key('doomed'));
			expect(await s.get(key('doomed'))).toBe(null);
			// The dislike route deletes a cache key that may already have expired,
			// and reports success either way.
			await s.delete(key('doomed'));
		});
	});
}
