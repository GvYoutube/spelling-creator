// Server-side image conversion: turn uploaded PNG/JPEG bytes into compressed
// WEBP before they land in R2. Runs in the Workers runtime (no native deps like
// sharp), using @jsquash's WASM codecs.
//
// We import each codec's .wasm as a precompiled WebAssembly.Module (wrangler
// resolves `.wasm` imports to a Module) and hand it to the codec's init() so the
// Emscripten/wasm-bindgen glue never tries to fetch the binary at runtime —
// which the Workers sandbox doesn't allow.

import encodeWebp, { init as initWebpEncode } from '@jsquash/webp/encode';
import decodePng, { init as initPngDecode } from '@jsquash/png/decode';
import decodeJpeg, { init as initJpegDecode } from '@jsquash/jpeg/decode';

import WEBP_ENC_WASM from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';
import PNG_DEC_WASM from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
import JPEG_DEC_WASM from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';

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
	if (!webpReady) webpReady = guardInit(initWebpEncode(WEBP_ENC_WASM), () => (webpReady = null));
	return webpReady;
}
function ensurePng() {
	if (!pngReady) pngReady = guardInit(initPngDecode(PNG_DEC_WASM), () => (pngReady = null));
	return pngReady;
}
function ensureJpeg() {
	if (!jpegReady) jpegReady = guardInit(initJpegDecode(JPEG_DEC_WASM), () => (jpegReady = null));
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
