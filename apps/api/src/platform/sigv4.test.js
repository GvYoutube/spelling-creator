// SigV4, checked against AWS's own published examples.
//
// Signing is the kind of code that is either exactly right or quietly wrong for
// a subset of inputs, and "quietly wrong" here means a self-hosted instance that
// stores most images fine and 403s on the one whose key has an unusual byte in
// it. Asserting only the final digest would catch that but tell you nothing; so
// each example also asserts the canonical request and the string-to-sign, which
// AWS publishes alongside, and which localise a mistake to one line.
//
// The examples are from "Signature Calculation: Transfer Payload in a Single
// Chunk" in the S3 API reference.

import { describe, expect, it } from 'vitest';

import { amzDate, canonicalQuery, signRequest, uriEncode } from './sigv4.js';

// The credentials AWS uses throughout its worked examples. Not secret, not real.
const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const REGION = 'us-east-1';
const DATE = new Date('2013-05-24T00:00:00Z');
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sign = (overrides) =>
	signRequest({
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: REGION,
		service: 's3',
		date: DATE,
		...overrides,
	});

describe('uriEncode', () => {
	it('leaves unreserved characters alone', () => {
		expect(uriEncode('abcXYZ019-_.~')).toBe('abcXYZ019-_.~');
	});

	it('encodes the characters encodeURIComponent would not', () => {
		// The reason this is hand-written rather than delegated: encodeURIComponent
		// passes these through, and a key containing one would then be signed
		// differently than it is sent.
		expect(uriEncode("!'()*")).toBe('%21%27%28%29%2A');
	});

	it('encodes a slash unless asked to keep it', () => {
		expect(uriEncode('git/abc/pack')).toBe('git%2Fabc%2Fpack');
		expect(uriEncode('git/abc/pack', true)).toBe('git/abc/pack');
	});

	it('percent-encodes multi-byte characters per UTF-8 byte', () => {
		expect(uriEncode('é')).toBe('%C3%A9');
		expect(uriEncode(' ')).toBe('%20');
	});
});

describe('canonicalQuery', () => {
	it('sorts by name and encodes both halves', () => {
		const params = new URLSearchParams([
			['prefix', 'J'],
			['max-keys', '2'],
		]);
		expect(canonicalQuery(params)).toBe('max-keys=2&prefix=J');
	});

	it('keeps a valueless parameter with its equals sign', () => {
		expect(canonicalQuery(new URLSearchParams('list-type=2&delimiter='))).toBe('delimiter=&list-type=2');
	});

	it('sorts repeated names by value', () => {
		expect(canonicalQuery(new URLSearchParams('a=2&a=1'))).toBe('a=1&a=2');
	});
});

describe('amzDate', () => {
	it('formats the AWS timestamp pair', () => {
		expect(amzDate(DATE)).toEqual({ amzdate: '20130524T000000Z', datestamp: '20130524' });
	});
});

describe('signRequest — AWS example: GET Object', () => {
	const request = () =>
		sign({
			method: 'GET',
			url: 'https://examplebucket.s3.amazonaws.com/test.txt',
			headers: { range: 'bytes=0-9' },
		});

	it('builds the published canonical request', async () => {
		const { canonicalRequest } = await request();
		expect(canonicalRequest).toBe(
			[
				'GET',
				'/test.txt',
				'',
				'host:examplebucket.s3.amazonaws.com',
				'range:bytes=0-9',
				`x-amz-content-sha256:${EMPTY_SHA256}`,
				'x-amz-date:20130524T000000Z',
				'',
				'host;range;x-amz-content-sha256;x-amz-date',
				EMPTY_SHA256,
			].join('\n'),
		);
	});

	it('builds the published string to sign', async () => {
		const { stringToSign } = await request();
		expect(stringToSign).toBe(
			[
				'AWS4-HMAC-SHA256',
				'20130524T000000Z',
				'20130524/us-east-1/s3/aws4_request',
				'7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
			].join('\n'),
		);
	});

	it('produces the published signature', async () => {
		const { signature } = await request();
		expect(signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
	});

	it('returns an authorization header naming exactly the headers it signed', async () => {
		const { headers } = await request();
		expect(headers.authorization).toBe(
			'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
				'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
				'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
		);
		// Everything named in SignedHeaders has to actually be sent, and nothing
		// signed may be dropped on the way out.
		expect(Object.keys(headers).sort()).toEqual(['authorization', 'host', 'range', 'x-amz-content-sha256', 'x-amz-date']);
	});
});

describe('signRequest — AWS example: PUT Object', () => {
	it('produces the published signature for a signed body', async () => {
		// The one example with a payload, so it is the one that proves the body
		// hash reaches both the canonical request and x-amz-content-sha256.
		const { signature, headers } = await sign({
			method: 'PUT',
			url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
			headers: {
				date: 'Fri, 24 May 2013 00:00:00 GMT',
				'x-amz-storage-class': 'REDUCED_REDUNDANCY',
			},
			body: 'Welcome to Amazon S3.',
		});
		expect(headers['x-amz-content-sha256']).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
		expect(signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
	});
});

describe('signRequest — AWS example: GET Bucket (List Objects)', () => {
	it('produces the published signature for a query-string request', async () => {
		// The example that exercises canonical query ordering — the query arrives
		// as prefix-then-max-keys and has to be signed the other way round.
		const { signature } = await sign({
			method: 'GET',
			url: 'https://examplebucket.s3.amazonaws.com?max-keys=2&prefix=J',
		});
		expect(signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
	});
});

describe('signRequest — behaviour the examples do not cover', () => {
	it('signs a session token when one is supplied', async () => {
		const { headers } = await sign({
			method: 'GET',
			url: 'https://examplebucket.s3.amazonaws.com/test.txt',
			sessionToken: 'token-value',
		});
		expect(headers['x-amz-security-token']).toBe('token-value');
		expect(headers.authorization).toContain('x-amz-security-token');
	});

	it('lower-cases and trims the header names it is given', async () => {
		const { canonicalRequest } = await sign({
			method: 'GET',
			url: 'https://examplebucket.s3.amazonaws.com/test.txt',
			headers: { 'Content-Type': '  text/plain  ' },
		});
		expect(canonicalRequest).toContain('content-type:text/plain\n');
	});

	it('encodes an object key that needs it', async () => {
		const { canonicalRequest } = await sign({
			method: 'GET',
			url: new URL('https://examplebucket.s3.amazonaws.com/git/a b/pack'),
		});
		// The path is canonicalised segment by segment, so the separators survive
		// and the space does not.
		expect(canonicalRequest.split('\n')[1]).toBe('/git/a%20b/pack');
	});
});
