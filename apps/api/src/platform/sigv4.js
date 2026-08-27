// AWS Signature Version 4, over WebCrypto and fetch.
//
// This exists so the S3 blob store can be a few hundred lines of `fetch` rather
// than a dependency on `@aws-sdk/client-s3`. That trade is worth making twice
// over: the SDK is tens of megabytes and assumes Node, where signing is a page
// of well-specified arithmetic that runs unchanged in workerd, in Node, and in
// a browser — every runtime this API might one day be hosted on has SHA-256 and
// HMAC in `crypto.subtle`.
//
// The signature covers the method, the path, the query, a chosen set of headers,
// and a hash of the body. Getting any of that canonicalisation subtly wrong
// produces a signature that is wrong for *some* requests and right for others —
// a key with a space in it, a query string in the wrong order — which is the
// worst possible failure mode. So the algorithm is implemented from the spec and
// checked against AWS's own published examples in sigv4.test.js, including the
// intermediate canonical request and string-to-sign, not only the final digest.
//
// Only what S3 needs is here: header-based (not query/presigned) authorization,
// single-chunk signed payloads, no session-token edge cases beyond passing one
// through.

const enc = new TextEncoder();

const ALGORITHM = 'AWS4-HMAC-SHA256';

/** Lowercase hex of a byte array. */
function hex(buffer) {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase hex SHA-256 of bytes or a string. */
export async function sha256Hex(data) {
	const bytes = typeof data === 'string' ? enc.encode(data) : data;
	return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** HMAC-SHA256, returning raw bytes so the key-derivation chain can feed itself. */
async function hmac(key, message) {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		typeof key === 'string' ? enc.encode(key) : key,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message)));
}

/**
 * Percent-encode per RFC 3986 as AWS defines it: unreserved characters pass
 * through, everything else becomes uppercase percent-encoding.
 *
 * This is not `encodeURIComponent`, which leaves `!'()*` alone — those must be
 * encoded here, or a key containing one signs differently than it is sent. The
 * path form keeps `/` literal, because S3 canonicalises an object key's slashes
 * as separators (and our keys have them: `git/<lessonId>/pack`).
 *
 * @param {string} value
 * @param {boolean} [keepSlash] Leave `/` unencoded — true for paths, false for query values.
 */
export function uriEncode(value, keepSlash = false) {
	let out = '';
	for (const char of String(value)) {
		if (/[A-Za-z0-9\-_.~]/.test(char) || (keepSlash && char === '/')) {
			out += char;
			continue;
		}
		for (const byte of enc.encode(char)) {
			out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		}
	}
	return out;
}

/**
 * Percent-decode one path segment, leaving it alone if it isn't valid encoding.
 *
 * `decodeURIComponent` throws on a stray `%` or a malformed sequence. A key that
 * contains one is not a reason to fail the request: signing the segment as the
 * literal text it appears to be is what the server will compare against anyway,
 * since that is what it received.
 *
 * @param {string} segment
 */
function decodeSegment(segment) {
	try {
		return decodeURIComponent(segment);
	} catch (e) {
		return segment;
	}
}

/**
 * The canonical query string: every parameter encoded, sorted by name and then
 * by value, joined with `&`. A parameter with no value still gets its `=`.
 *
 * @param {URLSearchParams} params
 */
export function canonicalQuery(params) {
	const pairs = [];
	for (const [name, value] of params) pairs.push([uriEncode(name), uriEncode(value)]);
	pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
	return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

/**
 * The AWS timestamp pair for an instant: `20130524T000000Z` and `20130524`.
 * @param {Date} date
 */
export function amzDate(date) {
	const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
	return { amzdate: iso, datestamp: iso.slice(0, 8) };
}

/**
 * The signing key for one date/region/service, derived from the secret by the
 * four-step HMAC chain. Not memoised: it is four HMACs of a few dozen bytes,
 * which is cheaper than reasoning about how long a derived key may be cached.
 */
async function signingKey(secretAccessKey, datestamp, region, service) {
	const dateKey = await hmac(`AWS4${secretAccessKey}`, datestamp);
	const regionKey = await hmac(dateKey, region);
	const serviceKey = await hmac(regionKey, service);
	return await hmac(serviceKey, 'aws4_request');
}

/**
 * Sign a request, returning the headers to send it with.
 *
 * The returned object is the *complete* header set — the caller's headers plus
 * `host`, `x-amz-date`, `x-amz-content-sha256`, an optional
 * `x-amz-security-token`, and `authorization`. Every one of those is included in
 * the signature, so they can't be added or edited afterwards.
 *
 * The intermediate values are returned alongside because the tests assert on
 * them: AWS publishes the canonical request and string-to-sign for its examples,
 * and matching those is what distinguishes a correct implementation from one
 * that happens to agree on a single digest.
 *
 * @param {object} request
 * @param {string} request.method
 * @param {string | URL} request.url
 * @param {Record<string, string>} [request.headers] Headers to sign alongside the required ones.
 * @param {Uint8Array | string} [request.body] Signed in full; omit for a bodyless request.
 * @param {string} request.accessKeyId
 * @param {string} request.secretAccessKey
 * @param {string} [request.sessionToken] For temporary credentials.
 * @param {string} request.region
 * @param {string} [request.service] Defaults to 's3'.
 * @param {Date} [request.date] The signing instant; defaults to now.
 * @returns {Promise<{ headers: Record<string, string>, canonicalRequest: string, stringToSign: string, signature: string }>}
 */
export async function signRequest({
	method,
	url,
	headers = {},
	body,
	accessKeyId,
	secretAccessKey,
	sessionToken,
	region,
	service = 's3',
	date = new Date(),
}) {
	const target = url instanceof URL ? url : new URL(url);
	const { amzdate, datestamp } = amzDate(date);
	const payloadHash = await sha256Hex(body === undefined || body === null ? '' : body);

	// Build the full header set first, then sign exactly what will be sent. The
	// signed set and the sent set being the same object is the property that
	// stops a header being added later and silently invalidating the signature.
	const signed = { host: target.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzdate };
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined && value !== null) signed[name.toLowerCase()] = String(value).trim();
	}
	if (sessionToken) signed['x-amz-security-token'] = sessionToken;

	const names = Object.keys(signed).sort();
	const canonicalHeaders = names.map((name) => `${name}:${signed[name]}\n`).join('');
	const signedHeaders = names.join(';');

	// S3 canonicalises an object key's path with a *single* encoding, where most
	// other services encode twice. `URL.pathname` is already percent-encoded, so
	// the segments have to be decoded before being re-encoded — encoding what is
	// there would turn `a%20b` into `a%2520b` and sign a path nobody asked for.
	const canonicalPath = target.pathname
		.split('/')
		.map((segment) => uriEncode(decodeSegment(segment)))
		.join('/');

	const canonicalRequest = [
		method.toUpperCase(),
		canonicalPath || '/',
		canonicalQuery(target.searchParams),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join('\n');

	const scope = `${datestamp}/${region}/${service}/aws4_request`;
	const stringToSign = [ALGORITHM, amzdate, scope, await sha256Hex(canonicalRequest)].join('\n');

	const key = await signingKey(secretAccessKey, datestamp, region, service);
	const signature = hex(await hmac(key, stringToSign));

	return {
		headers: {
			...signed,
			authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
		},
		canonicalRequest,
		stringToSign,
		signature,
	};
}
