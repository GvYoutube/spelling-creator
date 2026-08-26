// A BlobStore over any S3-compatible object store — MinIO, Garage, Ceph RGW,
// SeaweedFS, Backblaze B2, AWS itself.
//
// Built on `fetch` and the SigV4 signer next door rather than on
// `@aws-sdk/client-s3`, for the reasons set out in sigv4.js: the SDK is tens of
// megabytes and Node-shaped, where this is a few hundred lines that run
// unchanged in workerd, Node and anything else with `fetch` and `crypto.subtle`.
// Only five operations are needed, and none of them is complicated.
//
// Path-style addressing is the default (`http://host:9000/bucket/key`), because
// that is what a self-hosted MinIO or Garage serves out of the box and
// virtual-host style would need wildcard DNS. AWS wants the other one, so it is
// an option.
//
// Two places where S3 and R2 genuinely differ, both handled here so route code
// never learns about them:
//
//   * S3 object metadata rides in `x-amz-meta-*` headers, which are ASCII-only
//     by specification. R2's customMetadata takes arbitrary strings. So values
//     are percent-encoded on the way out and decoded on the way in, which makes
//     the round trip lossless without depending on a server tolerating bytes it
//     was never promised.
//
//   * A ListObjectsV2 response carries keys, sizes and ETags but NOT content
//     types, where R2's listing does. The BlobStore contract says a listing
//     carries content types (the WEBP backfill filters on them), so this adapter
//     pays for that with a HEAD per listed object — see list() for why that's
//     the right trade rather than weakening the contract.

import { deleteKeys, normalizeMetadata } from './blobs.js';
import { signRequest, uriEncode } from './sigv4.js';

// How many object deletes to have in flight at once. The lesson-delete path
// sweeps every proposal's pack in one call, so this can be a list of real
// length; the cap keeps that from opening a connection per key at a small
// self-hosted server that would rather not have them.
const DELETE_CONCURRENCY = 8;

// One page of ListObjectsV2 when a caller doesn't ask for a size. Matches the
// S3 default, and the only caller (the WEBP backfill) always asks.
const DEFAULT_PAGE_SIZE = 1000;

/**
 * Percent-encode a metadata value so it survives an `x-amz-meta-*` header.
 *
 * The header grammar is ASCII, and servers differ on what they do with anything
 * else — some reject it, some mangle it, some pass it through. Encoding removes
 * the question. `encodeURIComponent` is exactly right here (unlike in signing,
 * where AWS's stricter unreserved set matters) because both ends of this are us.
 */
const encodeMetaValue = (value) => encodeURIComponent(value);

/** The inverse, tolerant of a value that was never encoded (or is malformed). */
function decodeMetaValue(value) {
	try {
		return decodeURIComponent(value);
	} catch (e) {
		return value;
	}
}

/**
 * Read `x-amz-meta-*` headers back into a metadata map.
 * @param {Headers} headers
 */
function metadataFrom(headers) {
	const metadata = {};
	for (const [name, value] of headers) {
		if (name.toLowerCase().startsWith('x-amz-meta-')) {
			metadata[name.slice('x-amz-meta-'.length).toLowerCase()] = decodeMetaValue(value);
		}
	}
	return metadata;
}

/**
 * The BlobHead fields carried by an object response's headers.
 * @param {string} key
 * @param {Response} response
 */
function headFrom(key, response) {
	return {
		key,
		contentType: response.headers.get('content-type') || '',
		// S3 quotes the ETag, and so does R2's httpEtag — so it passes through
		// verbatim and both hosts serve the same header value.
		etag: response.headers.get('etag') || '',
		metadata: metadataFrom(response.headers),
		size: Number(response.headers.get('content-length') || 0) || 0,
	};
}

/**
 * The text between the first `<tag>` and its `</tag>` in `xml`, from `from`
 * onwards, or '' when the tag isn't there.
 *
 * ListObjectsV2 responses are a fixed, flat shape with no attributes and no
 * namespacing on the elements we read, which is why a scanner this small is
 * enough — and why it is preferable to pulling in an XML parser for one call.
 * It reads only the elements named below and ignores everything else, so an
 * unexpected element can add nothing and change nothing.
 */
function tagText(xml, tag, from = 0) {
	const open = xml.indexOf(`<${tag}>`, from);
	if (open === -1) return { value: '', end: from };
	const start = open + tag.length + 2;
	const close = xml.indexOf(`</${tag}>`, start);
	if (close === -1) return { value: '', end: from };
	return { value: xml.slice(start, close), end: close + tag.length + 3 };
}

/** Undo the five XML entities a conforming S3 server may emit in a key. */
function xmlUnescape(value) {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

/**
 * Pull the parts of a ListObjectsV2 response this store cares about.
 * @param {string} xml
 */
export function parseListResponse(xml) {
	const keys = [];
	let cursor = 0;
	for (;;) {
		const open = xml.indexOf('<Contents>', cursor);
		if (open === -1) break;
		const close = xml.indexOf('</Contents>', open);
		const entry = xml.slice(open, close === -1 ? undefined : close);
		const key = tagText(entry, 'Key').value;
		if (key) {
			keys.push({
				key: xmlUnescape(key),
				etag: xmlUnescape(tagText(entry, 'ETag').value),
				size: Number(tagText(entry, 'Size').value || 0) || 0,
			});
		}
		if (close === -1) break;
		cursor = close + '</Contents>'.length;
	}
	return {
		keys,
		truncated: tagText(xml, 'IsTruncated').value === 'true',
		nextCursor: tagText(xml, 'NextContinuationToken').value,
	};
}

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * Used for bulk deletes. The alternative — S3's DeleteObjects POST — would mean
 * building and signing an XML body for a saving that doesn't matter at the sizes
 * this sees, and it is the one bulk API smaller S3 implementations most often
 * don't have. Parallel DELETEs work everywhere.
 */
async function inBatches(items, limit, task) {
	for (let i = 0; i < items.length; i += limit) {
		await Promise.all(items.slice(i, i + limit).map(task));
	}
}

/**
 * An S3-compatible BlobStore.
 *
 * @param {object} config
 * @param {string} config.endpoint   Base URL of the S3 service, e.g. 'http://minio:9000'.
 * @param {string} config.bucket
 * @param {string} config.accessKeyId
 * @param {string} config.secretAccessKey
 * @param {string} [config.sessionToken]
 * @param {string} [config.region]   Defaults to 'us-east-1', which is what MinIO and Garage expect.
 * @param {boolean} [config.forcePathStyle] Defaults to true; set false for AWS-style virtual hosts.
 * @param {typeof fetch} [config.fetch] Injectable for tests.
 * @returns {import('./blobs.js').BlobStore}
 */
export function s3Blobs(config) {
	const {
		endpoint,
		bucket,
		accessKeyId,
		secretAccessKey,
		sessionToken,
		region = 'us-east-1',
		forcePathStyle = true,
		fetch: doFetch = fetch,
	} = config;

	const base = new URL(endpoint);

	/** The URL for an object key, or for the bucket itself when key is ''. */
	function urlFor(key, query) {
		const url = new URL(base);
		// Encode the key ourselves rather than letting `URL` decide: it would leave
		// a literal '?' or '#' to be read as a delimiter, and a key is opaque text.
		const path = key ? `/${uriEncode(key, true)}` : '/';
		if (forcePathStyle) {
			url.pathname = `/${bucket}${path}`;
		} else {
			url.host = `${bucket}.${url.host}`;
			url.pathname = path;
		}
		for (const [name, value] of Object.entries(query || {})) {
			if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
		}
		return url;
	}

	/** Sign and send one request. */
	async function send(method, key, { query, headers, body } = {}) {
		const url = urlFor(key, query);
		const signed = await signRequest({
			method,
			url,
			headers,
			body,
			accessKeyId,
			secretAccessKey,
			sessionToken,
			region,
			service: 's3',
		});
		return await doFetch(url.toString(), { method, headers: signed.headers, body });
	}

	/**
	 * Turn a failed response into an error carrying enough to diagnose it. The
	 * body is read (and truncated) because S3's error XML names the actual
	 * problem — SignatureDoesNotMatch versus NoSuchBucket is the difference
	 * between a config typo and a missing bucket.
	 */
	async function fail(operation, key, response) {
		const detail = await response.text().catch(() => '');
		const error = new Error(`S3 ${operation} ${key || bucket} failed: ${response.status} ${detail.slice(0, 300)}`);
		error.status = response.status;
		throw error;
	}

	// Named rather than reached for through `this`, because list() calls it and a
	// destructured `const { list } = store` must keep working.
	async function head(key) {
		const response = await send('HEAD', key);
		if (response.status === 404) return null;
		if (!response.ok) return await fail('HEAD', key, response);
		return headFrom(key, response);
	}

	return {
		head,

		async get(key) {
			const response = await send('GET', key);
			if (response.status === 404) {
				// Drain the body so the connection can be reused rather than dropped.
				await response.arrayBuffer().catch(() => {});
				return null;
			}
			if (!response.ok) return await fail('GET', key, response);
			return {
				...headFrom(key, response),
				body: response.body,
				bytes: async () => new Uint8Array(await response.arrayBuffer()),
				text: () => response.text(),
				json: () => response.json(),
			};
		},

		async put(key, bytes, opts) {
			const headers = { 'content-type': opts?.contentType || 'application/octet-stream' };
			for (const [name, value] of Object.entries(normalizeMetadata(opts?.metadata))) {
				headers[`x-amz-meta-${name.toLowerCase()}`] = encodeMetaValue(value);
			}
			const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
			const response = await send('PUT', key, { headers, body });
			if (!response.ok) return await fail('PUT', key, response);
			await response.arrayBuffer().catch(() => {});
		},

		async delete(key) {
			const keys = deleteKeys(key);
			if (keys.length === 0) return;
			await inBatches(keys, DELETE_CONCURRENCY, async (one) => {
				const response = await send('DELETE', one);
				// S3 answers 204 for a key that was never there, which is the no-op
				// the contract asks for; 404 from a stricter implementation means the
				// same thing.
				if (!response.ok && response.status !== 404) return await fail('DELETE', one, response);
				await response.arrayBuffer().catch(() => {});
			});
		},

		async list(opts) {
			const response = await send('GET', '', {
				query: {
					'list-type': '2',
					'max-keys': String(opts?.limit || DEFAULT_PAGE_SIZE),
					'continuation-token': opts?.cursor || undefined,
				},
			});
			if (!response.ok) return await fail('LIST', '', response);
			const parsed = parseListResponse(await response.text());

			// ListObjectsV2 doesn't report content types, and the contract says a
			// listing carries them — so fetch them. This is a HEAD per object, which
			// sounds worse than it is: the only caller is the one-time WEBP backfill,
			// which pages in batches of at most 50 and then reads and rewrites every
			// object it didn't skip. Weakening the contract instead would push the
			// same cost onto the caller as a full GET per object, on every host.
			const objects = [];
			await inBatches(parsed.keys, DELETE_CONCURRENCY, async (entry) => {
				const meta = await head(entry.key).catch(() => null);
				// An object listed and then deleted before we could HEAD it still
				// belongs in the page — the caller will skip it when its get() misses.
				objects.push(meta || { ...entry, contentType: '', metadata: {} });
			});
			// inBatches resolves within a batch in completion order, so restore the
			// server's ordering — a cursor-paged caller depends on it being stable.
			const order = new Map(parsed.keys.map((entry, index) => [entry.key, index]));
			objects.sort((a, b) => order.get(a.key) - order.get(b.key));

			return {
				objects,
				cursor: parsed.truncated ? parsed.nextCursor : '',
				truncated: parsed.truncated,
			};
		},
	};
}
