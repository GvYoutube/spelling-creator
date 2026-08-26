// Lesson images in the object store, addressed by their content hash. GET/HEAD is
// public (published lessons and the og-image/prerender browser load them); PUT is
// authenticated and verifies the body against the hash.

import { verifySupabaseUser } from '../lib/supabase.js';
import { IMAGE_HASH_RE, MAX_IMAGE_BYTES, sha256Hex, putImageObject } from '../lib/images.js';
import { textResponse, jsonResponse } from '../lib/http.js';
import { imageStore, responseCache } from '../platform/index.js';

/**
 * GET/HEAD /images/:hash — serve a lesson image by its content hash. Public:
 * published lessons are viewed by anyone, and the og-image/prerender headless
 * browser fetches these too. Content-addressed, so the bytes for a given hash
 * never change — the response is immutable and cached forever. 404 when the
 * object isn't present.
 */
export async function handleImageGet(request, env, ctx, hash) {
	// Images are public; a static `*` ACAO is cache-safe (no per-origin variance,
	// so one cached copy serves everyone) and lets cross-origin reads work too
	// (e.g. the export byte-fetch when the SPA origin differs from the API).
	const ACAO = { 'Access-Control-Allow-Origin': '*' };
	const images = imageStore(env);
	if (!images) return new Response('Image store is not configured.', { status: 500, headers: ACAO });
	if (!IMAGE_HASH_RE.test(hash)) return new Response('Invalid image id.', { status: 400, headers: ACAO });

	// Content-addressed and immutable: the bytes for a given hash never change, so
	// cache the response. Repeat reads — every public lesson view, the
	// og-image/prerender browser, export byte-fetches — are then served from cache
	// and DON'T each cost an object-store read operation (key to staying in
	// Cloudflare's free tier under traffic).
	const cache = responseCache(env);
	const cacheKey = new URL(`/images/${hash}`, request.url).toString();
	if (request.method === 'GET') {
		const hit = await cache.match(cacheKey);
		if (hit) return hit;
	}

	const baseHeaders = {
		...ACAO,
		'Cache-Control': 'public, max-age=31536000, immutable',
	};

	// HEAD only needs metadata — head() avoids transferring (and is cheaper than)
	// a full get().
	if (request.method === 'HEAD') {
		const meta = await images.head(hash);
		if (!meta) return new Response('Image not found.', { status: 404, headers: ACAO });
		const headers = new Headers(baseHeaders);
		headers.set('Content-Type', meta.contentType || 'application/octet-stream');
		if (meta.etag) headers.set('ETag', meta.etag);
		return new Response(null, { status: 200, headers });
	}

	const object = await images.get(hash);
	if (!object) return new Response('Image not found.', { status: 404, headers: ACAO });
	const headers = new Headers(baseHeaders);
	headers.set('Content-Type', object.contentType || 'application/octet-stream');
	if (object.etag) headers.set('ETag', object.etag);
	const response = new Response(object.body, { status: 200, headers });
	// Populate the cache for subsequent reads of this immutable object.
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

/**
 * PUT /images/:hash — store a lesson image. Requires a verified Supabase session
 * (so anonymous callers can't fill the bucket), and verifies the body's SHA-256
 * equals :hash so a caller can't store arbitrary content at a key they don't
 * control. Idempotent — re-uploading identical bytes is a harmless no-op.
 */
export async function handleImagePut(request, env, hash, cors) {
	if (!imageStore(env)) return textResponse('Image store is not configured.', 500, cors);
	if (!IMAGE_HASH_RE.test(hash)) return textResponse('Invalid image id.', 400, cors);

	const auth = request.headers.get('Authorization') || '';
	const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
	const user = await verifySupabaseUser(env, token);
	if (!user) return textResponse('Please sign in before uploading images.', 401, cors);

	const contentType = request.headers.get('Content-Type') || '';
	if (!contentType.startsWith('image/')) {
		return textResponse('Only image uploads are allowed.', 415, cors);
	}

	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength === 0) return textResponse('Empty image upload.', 400, cors);
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		return textResponse('Image is too large (max 8 MB).', 413, cors);
	}

	// The key IS the content hash: reject bytes that don't hash to it.
	if ((await sha256Hex(bytes)) !== hash) {
		return textResponse('Upload does not match its content hash.', 422, cors);
	}

	// Idempotent + compresses to WEBP before storing (see putImageObject).
	await putImageObject(env, hash, bytes, contentType);
	return jsonResponse({ ok: true }, 200, cors);
}
