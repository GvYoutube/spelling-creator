// BlobStore — the object-storage interface this API stores lesson images and
// lesson-history packfiles through.
//
// It is deliberately the intersection of R2 and S3 rather than either one: five
// methods, no multipart, no conditional writes, no presigning, no ACLs. Both
// stores here are content-addressed or author-owned and written whole, so
// nothing needs more than this — and keeping it this small is what lets an S3
// adapter (MinIO, Garage, Ceph, AWS) be a couple of hundred lines.
//
// The shapes below are normalised away from R2's own vocabulary. R2 hands back
// `httpMetadata.contentType`, `httpEtag` and `customMetadata`; S3 hands back
// `ContentType`, `ETag` and `Metadata`. Neither name appears in route code —
// they see `contentType`, `etag` and `metadata`.
//
// This file is types and documentation only; the implementations live beside it.

/**
 * What a stored object's metadata looks like once normalised.
 *
 * @typedef {object} BlobHead
 * @property {string} key
 * @property {string} contentType  '' when the object was stored without one.
 * @property {string} etag         '' when the host doesn't report one.
 * @property {Record<string, string>} metadata  User metadata; {} when there is none.
 * @property {number} size         Bytes. 0 when the host doesn't report a size.
 */

/**
 * A stored object, with its bytes.
 *
 * `body` is a web ReadableStream, so a handler can stream it straight into a
 * Response without buffering it — which is the whole point for images. `bytes()`
 * / `text()` / `json()` are for the callers that need the value in hand, and
 * each consumes the object once, exactly like a Response.
 *
 * @typedef {BlobHead & {
 *   body: ReadableStream,
 *   bytes: () => Promise<Uint8Array>,
 *   text: () => Promise<string>,
 *   json: () => Promise<any>,
 * }} BlobObject
 */

/**
 * One page of a listing.
 *
 * @typedef {object} BlobListing
 * @property {BlobHead[]} objects
 * @property {string} cursor      Opaque; pass back to continue. '' when done.
 * @property {boolean} truncated  Whether more objects follow this page.
 */

/**
 * The interface itself.
 *
 * @typedef {object} BlobStore
 * @property {(key: string) => Promise<BlobHead | null>} head
 *   Metadata only, without transferring the bytes. null when absent.
 * @property {(key: string) => Promise<BlobObject | null>} get
 *   The object and its bytes. null when absent.
 * @property {(key: string, bytes: Uint8Array | string, opts?: { contentType?: string, metadata?: Record<string, string> }) => Promise<void>} put
 *   Store bytes at a key, replacing whatever was there.
 * @property {(key: string | string[]) => Promise<void>} delete
 *   Remove one key or several. Deleting an absent key is not an error.
 * @property {(opts?: { limit?: number, cursor?: string }) => Promise<BlobListing>} list
 *   One page of keys, with metadata (so a caller can filter without a get()).
 */

/**
 * Normalise the `metadata` argument callers pass to put(): drop anything that
 * isn't a plain string value, since both R2's customMetadata and S3's Metadata
 * are string maps and a stray number would round-trip as something else.
 *
 * Exported because every adapter needs it and none of them should each decide
 * what "metadata" means.
 *
 * @param {Record<string, unknown> | undefined} metadata
 * @returns {Record<string, string>}
 */
export function normalizeMetadata(metadata) {
	const out = {};
	for (const [k, v] of Object.entries(metadata || {})) {
		if (typeof v === 'string') out[k] = v;
	}
	return out;
}

/**
 * The list of keys a delete() call should act on, given either form of its
 * argument, with blanks dropped. Adapters use this so `delete([])` is a no-op
 * everywhere rather than an error at one host and a full-bucket scan at another.
 *
 * @param {string | string[]} key
 * @returns {string[]}
 */
export function deleteKeys(key) {
	const keys = Array.isArray(key) ? key : [key];
	return keys.filter((k) => typeof k === 'string' && k !== '');
}
