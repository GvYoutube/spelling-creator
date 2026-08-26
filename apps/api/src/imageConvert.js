// Server-side image conversion: turn uploaded PNG/JPEG bytes into compressed
// WEBP before they land in the object store. Uses @jsquash's WASM codecs rather
// than a native dependency like sharp, which is what lets the same code run in
// the Workers runtime and in Node without a build step per platform.
//
// Each codec's init() is handed an already-compiled `WebAssembly.Module`, so the
// Emscripten/wasm-bindgen glue never tries to fetch the binary at runtime — the
// Workers sandbox doesn't allow that, and in Node it would resolve against the
// wrong base. Where that Module comes from is the one part that differs per
// runtime, and it lives behind the `#image-codec-wasm` subpath import (see
// package.json and src/codecs/): wrangler's bundler on Workers, a read and
// compile off disk in Node.

// The `.js` extensions are required, not stylistic: @jsquash ships no `exports`
// map, so these resolve as plain files — and Node's ESM resolver does not guess
// an extension the way a bundler does. Without them this module loads under
// wrangler and vitest and fails at startup under plain `node`.
import encodeWebp, { init as initWebpEncode } from '@jsquash/webp/encode.js';
import decodePng, { init as initPngDecode } from '@jsquash/png/decode.js';
import decodeJpeg, { init as initJpegDecode } from '@jsquash/jpeg/decode.js';

import { jpegDecoderWasm, pngDecoderWasm, webpEncoderWasm } from '#image-codec-wasm';

// Quality for the WEBP encoder (0–100). 80 is the usual "visually lossless
// enough" sweet spot and what most image pipelines default to.
const WEBP_QUALITY = 80;

// Input mimes we know how to decode. gif (often animated), bmp, svg and already-
// webp are passed through untouched — we have no decoder for them and don't want
// to flatten animations or rasterise vectors.
const CONVERTIBLE = new Set(['image/png', 'image/jpeg', 'image/jpg']);

// Init is per-isolate and idempotent; guard each codec so concurrent uploads
// don't double-initialise. A failed init is retried on the next call.
let webpReady = null;
let pngReady = null;
let jpegReady = null;

function guardInit(promise, reset) {
	return promise.catch((e) => {
		reset();
		throw e;
	});
}
function ensureWebp() {
	if (!webpReady) webpReady = guardInit(webpEncoderWasm().then(initWebpEncode), () => (webpReady = null));
	return webpReady;
}
function ensurePng() {
	if (!pngReady) pngReady = guardInit(pngDecoderWasm().then(initPngDecode), () => (pngReady = null));
	return pngReady;
}
function ensureJpeg() {
	if (!jpegReady) jpegReady = guardInit(jpegDecoderWasm().then(initJpegDecode), () => (jpegReady = null));
	return jpegReady;
}

async function decode(bytes, mime) {
	if (mime === 'image/png') {
		await ensurePng();
		return decodePng(bytes);
	}
	// image/jpeg or image/jpg
	await ensureJpeg();
	return decodeJpeg(bytes);
}

/**
 * Convert image bytes to compressed WEBP. Returns `{ bytes, contentType }`:
 * the WEBP when conversion succeeds AND is smaller than the original, otherwise
 * the original bytes/mime unchanged. Never throws — image storage must not fail
 * just because a particular file couldn't be transcoded.
 */
export async function convertImageToWebp(bytes, mime) {
	const normalized = (mime || '').toLowerCase().split(';')[0].trim();
	if (!CONVERTIBLE.has(normalized)) {
		return { bytes, contentType: normalized || 'application/octet-stream' };
	}
	try {
		const imageData = await decode(bytes, normalized);
		await ensureWebp();
		const webp = new Uint8Array(await encodeWebp(imageData, { quality: WEBP_QUALITY }));
		// Don't regress: keep whichever is smaller. (Re-encoding an already-small
		// PNG to WEBP can occasionally grow it.)
		if (webp.byteLength > 0 && webp.byteLength < bytes.byteLength) {
			return { bytes: webp, contentType: 'image/webp' };
		}
		return { bytes, contentType: normalized };
	} catch (err) {
		console.error('WEBP conversion failed; storing original bytes:', err);
		return { bytes, contentType: normalized };
	}
}
