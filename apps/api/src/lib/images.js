// Content-addressed image storage helpers. Lesson images live in R2 keyed by the
// SHA-256 of their (pre-conversion) bytes; the browser computes the same hash
// (web/src/lib/imageStore.js), so an object key is verifiable from its bytes.

import { convertImageToWebp } from '../imageConvert.js';

// A valid image object key is a 64-char lowercase hex SHA-256.
export const IMAGE_HASH_RE = /^[0-9a-f]{64}$/;
// Cap a single image so one PUT can't fill the bucket (also mirrored client-side).
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Lowercase hex SHA-256 of the given bytes — matches the hash the browser
// computes (web/src/lib/imageStore.js) so a content-addressed object key is
// verifiable from its bytes.
export async function sha256Hex(bytes) {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Store image bytes in R2 under their content-hash key, first compressing them
// to WEBP (convertImageToWebp falls back to the original bytes for formats it
// can't transcode or when WEBP wouldn't be smaller). The key stays the ORIGINAL
// hash — lesson docs reference images by the hash of their pre-conversion bytes,
// so only the stored bytes and Content-Type change, transparently to readers.
// Idempotent: an object already at this key holds a prior (converted) upload, so
// skip both the conversion work and the write.
export async function putImageObject(env, hash, bytes, mime) {
	if (await env.IMAGES.head(hash)) return;
	const converted = await convertImageToWebp(bytes, mime);
	await env.IMAGES.put(hash, converted.bytes, { httpMetadata: { contentType: converted.contentType } });
}

// docx ext rules, mirroring web/src/lib/imageRef.js extFromMime.
export function extFromMime(mime) {
	const raw = (mime || '').toLowerCase().replace(/^image\//, '');
	if (raw === 'jpeg') return 'jpg';
	if (raw === 'svg+xml') return 'png';
	if (['png', 'jpg', 'gif', 'bmp'].includes(raw)) return raw;
	return 'png';
}

// Split a base64/percent-encoded data URL into raw bytes + mime (server side).
export function decodeDataUrl(dataUrl) {
	const comma = dataUrl.indexOf(',');
	if (comma === -1) return null;
	const header = dataUrl.slice(5, comma);
	const mime = header.split(';')[0] || 'image/png';
	const payload = dataUrl.slice(comma + 1);
	let bytes;
	if (/;base64/i.test(header)) {
		const binary = atob(payload);
		bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	} else {
		bytes = new TextEncoder().encode(decodeURIComponent(payload));
	}
	return { bytes, mime };
}
