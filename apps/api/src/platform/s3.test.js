// The S3 blob store, run against an in-process S3.
//
// The conformance suite is the point of this file: the S3 adapter has to answer
// the same way the R2 one does, and "the same way" is defined by the suite both
// of them run (see conformance.js). What differs here is what it runs against —
// a small S3 server implemented over the Map below, wired in as `fetch`.
//
// A stub rather than a real MinIO because the alternative is a container in CI,
// and because a stub can be *strict* in ways a real server isn't: this one
// rejects an unsigned request, so every test also asserts that the request was
// signed, and it holds metadata as the raw header bytes it received, so the
// percent-encoding round trip is exercised rather than assumed. What it can't
// prove is that a real server agrees with it — that's what sigv4.test.js's
// published AWS vectors are for.

import { describe, expect, it } from 'vitest';

import { testBlobStore } from './conformance.js';
import { parseListResponse, s3Blobs } from './s3.js';
import { xmlEscape } from '../lib/xml.js';

const enc = new TextEncoder();

/**
 * An in-memory S3 speaking enough of the API for this adapter: GET/HEAD/PUT/
 * DELETE on an object, and ListObjectsV2 on the bucket.
 *
 * @param {string} bucket
 * @returns {{ fetch: typeof fetch, objects: Map<string, object> }}
 */
function fakeS3(bucket) {
	/** @type {Map<string, { body: Uint8Array, headers: Record<string, string> }>} */
	const objects = new Map();

	const notFound = () => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });

	function listObjects(url) {
		const limit = Number(url.searchParams.get('max-keys') || 1000);
		const after = url.searchParams.get('continuation-token') || '';
		// Real S3 returns keys in lexicographic order and continues after the token,
		// so the stub does too — the contract's paging assertions depend on it.
		const all = [...objects.keys()].sort();
		const start = after ? all.indexOf(after) + 1 : 0;
		const page = all.slice(start, start + limit);
		const truncated = start + limit < all.length;
		const body = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<ListBucketResult>',
			`<IsTruncated>${truncated}</IsTruncated>`,
			...page.map((key) => {
				const object = objects.get(key);
				return `<Contents><Key>${xmlEscape(key)}</Key><Size>${object.body.byteLength}</Size><ETag>&quot;etag-${xmlEscape(key)}&quot;</ETag></Contents>`;
			}),
			truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1])}</NextContinuationToken>` : '',
			'</ListBucketResult>',
		].join('');
		return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
	}

	async function handle(input, init) {
		const url = new URL(input);
		const method = (init.method || 'GET').toUpperCase();
		const headers = new Headers(init.headers);

		// Strict on purpose: an adapter that forgot to sign would otherwise pass
		// every test here and fail against every real server.
		if (!headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 ')) {
			return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
		}
		if (!headers.get('x-amz-content-sha256') || !headers.get('x-amz-date')) {
			return new Response('<Error><Code>InvalidRequest</Code></Error>', { status: 400 });
		}

		const prefix = `/${bucket}/`;
		if (!url.pathname.startsWith(`/${bucket}`)) {
			return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
		}
		const key = decodeURIComponent(url.pathname.slice(prefix.length));

		if (method === 'GET' && url.searchParams.get('list-type') === '2') return listObjects(url);

		if (method === 'PUT') {
			const stored = {};
			for (const [name, value] of headers) {
				// Keep the metadata exactly as it arrived, so a value the adapter
				// encoded has to be decoded by the adapter to read back.
				if (name.startsWith('x-amz-meta-') || name === 'content-type') stored[name] = value;
			}
			const body = new Uint8Array(init.body instanceof Uint8Array ? init.body : await new Response(init.body).arrayBuffer());
			objects.set(key, { body, headers: stored });
			return new Response(null, { status: 200, headers: { etag: `"etag-${key}"` } });
		}

		if (method === 'DELETE') {
			objects.delete(key);
			return new Response(null, { status: 204 });
		}

		const object = objects.get(key);
		if (!object) return notFound();
		const responseHeaders = new Headers({
			...object.headers,
			etag: `"etag-${key}"`,
			'content-length': String(object.body.byteLength),
		});
		if (method === 'HEAD') return new Response(null, { status: 200, headers: responseHeaders });
		return new Response(object.body, { status: 200, headers: responseHeaders });
	}

	return { fetch: (input, init = {}) => handle(input, init), objects };
}

const storeOver = (server, overrides) =>
	s3Blobs({
		endpoint: 'https://objects.test',
		bucket: 'lessons',
		accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
		secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
		region: 'us-east-1',
		fetch: server.fetch,
		...overrides,
	});

// One server for the whole conformance run, so the paging cases see each other's
// objects the way they would in a real bucket.
const conformanceServer = fakeS3('lessons');

testBlobStore({
	store: () => storeOver(conformanceServer),
	prefix: 'conformance/',
	vitest: { describe, expect, it },
});

describe('parseListResponse', () => {
	it('reads keys, truncation and the continuation token', () => {
		const parsed = parseListResponse(
			'<ListBucketResult><IsTruncated>true</IsTruncated>' +
				'<Contents><Key>a</Key><Size>3</Size><ETag>&quot;x&quot;</ETag></Contents>' +
				'<Contents><Key>b</Key><Size>4</Size><ETag>&quot;y&quot;</ETag></Contents>' +
				'<NextContinuationToken>tok</NextContinuationToken></ListBucketResult>',
		);
		expect(parsed.keys.map((k) => k.key)).toEqual(['a', 'b']);
		expect(parsed.keys[0].size).toBe(3);
		expect(parsed.truncated).toBe(true);
		expect(parsed.nextCursor).toBe('tok');
	});

	it('reads an empty bucket', () => {
		const parsed = parseListResponse('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
		expect(parsed.keys).toEqual([]);
		expect(parsed.truncated).toBe(false);
	});

	it('un-escapes entities in a key', () => {
		const parsed = parseListResponse('<ListBucketResult><Contents><Key>a&amp;b&lt;c</Key></Contents></ListBucketResult>');
		expect(parsed.keys[0].key).toBe('a&b<c');
	});

	it('ignores elements it does not know about', () => {
		// A server that adds StorageClass or Owner must not shift anything.
		const parsed = parseListResponse(
			'<ListBucketResult><IsTruncated>false</IsTruncated>' +
				'<Contents><Key>a</Key><StorageClass>STANDARD</StorageClass><Owner><ID>x</ID></Owner></Contents>' +
				'</ListBucketResult>',
		);
		expect(parsed.keys.map((k) => k.key)).toEqual(['a']);
	});
});

describe('s3Blobs addressing', () => {
	it('uses path style by default', async () => {
		const seen = [];
		const store = s3Blobs({
			endpoint: 'https://objects.test',
			bucket: 'lessons',
			accessKeyId: 'k',
			secretAccessKey: 's',
			fetch: async (url) => {
				seen.push(url);
				return new Response(null, { status: 404 });
			},
		});
		await store.head('git/abc/pack');
		// Path style is the default because MinIO and Garage serve it without
		// wildcard DNS, which is the whole point of self-hosting.
		expect(seen[0]).toBe('https://objects.test/lessons/git/abc/pack');
	});

	it('uses virtual-host style when asked', async () => {
		const seen = [];
		const store = s3Blobs({
			endpoint: 'https://s3.amazonaws.com',
			bucket: 'lessons',
			accessKeyId: 'k',
			secretAccessKey: 's',
			forcePathStyle: false,
			fetch: async (url) => {
				seen.push(url);
				return new Response(null, { status: 404 });
			},
		});
		await store.head('image');
		expect(seen[0]).toBe('https://lessons.s3.amazonaws.com/image');
	});
});

describe('s3Blobs metadata encoding', () => {
	it('sends metadata as ASCII and reads it back intact', async () => {
		const server = fakeS3('lessons');
		const store = storeOver(server);
		await store.put('unicode-meta', enc.encode('x'), { metadata: { branch: 'variación — b' } });

		// x-amz-meta-* is ASCII by specification, and servers differ on what they
		// do with anything else. Encoding removes the question.
		const sent = server.objects.get('unicode-meta').headers['x-amz-meta-branch'];
		// eslint-disable-next-line no-control-regex
		expect(/^[\x00-\x7F]*$/.test(sent)).toBe(true);
		expect((await store.get('unicode-meta')).metadata.branch).toBe('variación — b');
	});

	it('reads a value that was stored without encoding', async () => {
		// Objects written by something other than this adapter still have to read.
		const server = fakeS3('lessons');
		server.objects.set('foreign', {
			body: enc.encode('x'),
			headers: { 'content-type': 'text/plain', 'x-amz-meta-head': 'abc' },
		});
		expect((await storeOver(server).get('foreign')).metadata.head).toBe('abc');
	});
});

describe('s3Blobs errors', () => {
	it('throws with the server’s error code when a write fails', async () => {
		const store = s3Blobs({
			endpoint: 'https://objects.test',
			bucket: 'lessons',
			accessKeyId: 'k',
			secretAccessKey: 's',
			fetch: async () => new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 }),
		});
		// The body matters: SignatureDoesNotMatch versus NoSuchBucket is the
		// difference between a credentials typo and a missing bucket.
		await expect(store.put('k', enc.encode('x'))).rejects.toThrow(/SignatureDoesNotMatch/);
	});

	it('treats a delete of an absent key as a no-op even on a strict server', async () => {
		const store = s3Blobs({
			endpoint: 'https://objects.test',
			bucket: 'lessons',
			accessKeyId: 'k',
			secretAccessKey: 's',
			fetch: async () => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }),
		});
		await store.delete('absent');
	});

	it('signs every request it sends', async () => {
		// The stub rejects an unsigned request with 403, so a missing signature
		// surfaces as an error rather than as a silent pass.
		const store = storeOver(fakeS3('lessons'));
		await expect(store.get('anything')).resolves.toBe(null);
	});
});
