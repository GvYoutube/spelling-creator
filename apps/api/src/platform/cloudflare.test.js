// The Cloudflare adapters, run against real R2 and KV inside workerd.
//
// These are the reference results: whatever the shared conformance suite asserts
// here is what a self-hosted adapter has to reproduce. Running them against
// Miniflare's R2/KV rather than fakes is the entire point — the behaviours worth
// pinning down (a miss is null, metadata round-trips, an empty delete is a no-op)
// are the runtime's, not ours, and a fake would just re-state our assumptions.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { r2Blobs, kvStore, cloudflarePlatform } from './cloudflare.js';
import { testBlobStore, testKvStore } from './conformance.js';

const vitest = { describe, expect, it };

testBlobStore({
	store: () => r2Blobs(env.TEST_BLOBS),
	prefix: 'conformance/',
	vitest,
});

testKvStore({
	store: () => kvStore(env.TEST_KV),
	prefix: 'conformance:',
	vitest,
});

describe('cloudflarePlatform', () => {
	it('omits a store whose binding is absent', () => {
		// A preview deployment without a bucket still serves every route that
		// doesn't need one, which is only true if an absent binding reads as null
		// rather than as a store that throws on first use.
		const platform = cloudflarePlatform({});
		expect(platform.images).toBe(null);
		expect(platform.lessonGit).toBe(null);
		expect(platform.rateLimit).toBe(null);
		expect(platform.oauthState).toBe(null);
	});

	it('always provides a response cache', () => {
		// Unlike the stores, "no cache" is not a valid answer for callers — they
		// call match() unconditionally.
		expect(typeof cloudflarePlatform({}).cache.match).toBe('function');
	});

	it('reads the client IP from cf-connecting-ip only', () => {
		const platform = cloudflarePlatform({});
		const request = new Request('https://example.test/', {
			headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' },
		});
		// x-forwarded-for is client-supplied on this host, and the IP feeds bans —
		// so the edge's own header is the only one trusted here.
		expect(platform.clientIp(request)).toBe('203.0.113.7');
		expect(platform.clientIp(new Request('https://example.test/'))).toBe('');
	});
});

describe('edgeCache', () => {
	it('survives an uncacheable response without failing the caller', async () => {
		// `caches.default.put` rejects a response the Cache API won't store (a 206,
		// a no-store). The image route caches inside waitUntil and must not turn
		// that into a failed request.
		const cache = cloudflarePlatform({}).cache;
		await cache.put('https://example.test/uncacheable', new Response('x', { status: 206, headers: { 'Cache-Control': 'no-store' } }));
		expect(await cache.match('https://example.test/uncacheable')).toBe(null);
	});
});
