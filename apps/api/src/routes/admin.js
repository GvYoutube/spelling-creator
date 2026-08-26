// One-time admin backfills, gated by a secret X-Admin-Token header. One converts
// existing lessons' inline base64 images into stored objects + hash refs; the
// other re-compresses pre-existing stored images to WEBP.

import { supabaseHeaders } from '../lib/supabase.js';
import { sha256Hex, extFromMime, decodeDataUrl, putImageObject } from '../lib/images.js';
import { convertImageToWebp } from '../imageConvert.js';
import { textResponse, jsonResponse } from '../lib/http.js';
import { imageStore, responseCache } from '../platform/index.js';

// Constant-time string compare so the admin token check doesn't leak length/
// content via timing.
function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// Walk a lesson doc in place: upload each inline base64 image to R2 and rewrite
// the block to a hash ref. Returns the number of images converted (0 = nothing).
async function migrateDocImages(env, doc) {
	if (!doc || !Array.isArray(doc.sections)) return 0;
	let migrated = 0;
	for (const section of doc.sections) {
		for (const block of section.blocks || []) {
			if (block.type !== 'image' || !block.src || block.image) continue;
			const decoded = decodeDataUrl(block.src);
			if (!decoded) continue;
			const hash = await sha256Hex(decoded.bytes);
			await putImageObject(env, hash, decoded.bytes, decoded.mime);
			block.image = { hash, mime: decoded.mime, ext: extFromMime(decoded.mime) };
			delete block.src;
			migrated += 1;
		}
	}
	return migrated;
}

/**
 * POST /admin/migrate-images — one-time backfill that converts existing lessons'
 * inline base64 images into binary R2 objects + hash refs. Gated by a secret
 * `X-Admin-Token` header (env.ADMIN_MIGRATE_TOKEN). Pages through lessons oldest
 * first (stable: only the doc is rewritten, never created_at/id), and only
 * PATCHes a row when its doc actually changed. Idempotent — a row already
 * converted has no inline base64 images and is left untouched.
 *
 *   body: { cursor?: number (offset, default 0), limit?: number (default 25) }
 *   ->    { processed, migrated, nextCursor }   (nextCursor null when finished)
 */
export async function handleAdminMigrateImages(request, env, cors) {
	if (request.method !== 'POST') return textResponse('Method not allowed.', 405, cors);
	if (!env.ADMIN_MIGRATE_TOKEN) return textResponse('Server misconfiguration: ADMIN_MIGRATE_TOKEN not set', 500, cors);
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (!imageStore(env)) return textResponse('Image store is not configured.', 500, cors);

	const provided = request.headers.get('X-Admin-Token') || '';
	if (!timingSafeEqual(provided, env.ADMIN_MIGRATE_TOKEN)) {
		return textResponse('Forbidden.', 403, cors);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		body = {};
	}
	const offset = Math.max(0, Number(body.cursor) || 0);
	const limit = Math.max(1, Math.min(Number(body.limit) || 25, 100));

	const base = env.SUPABASE_URL.replace(/\/$/, '');
	const query = `select=id,doc&order=created_at.asc,id.asc&offset=${offset}&limit=${limit}`;
	let res;
	try {
		res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
	} catch (e) {
		return textResponse('Could not reach the lesson store.', 502, cors);
	}
	if (!res.ok) return textResponse('Could not load lessons.', 502, cors);
	const rows = await res.json().catch(() => []);
	const list = Array.isArray(rows) ? rows : [];

	let migrated = 0;
	for (const row of list) {
		const count = await migrateDocImages(env, row.doc);
		if (count === 0) continue;
		migrated += count;
		// Persist the rewritten doc. section_count is a generated column, so it
		// recomputes automatically from the (unchanged-length) sections array.
		const patchRes = await fetch(`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(row.id)}`, {
			method: 'PATCH',
			headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json' },
			body: JSON.stringify({ doc: row.doc }),
		});
		if (!patchRes.ok) return textResponse(`Failed to update lesson ${row.id}.`, 502, cors);
	}

	const nextCursor = list.length < limit ? null : offset + list.length;
	return jsonResponse({ processed: list.length, migrated, nextCursor }, 200, cors);
}

/**
 * POST /admin/backfill-webp — one-time backfill that re-compresses images already
 * in R2 (uploaded before the PUT handler started converting) to WEBP. Gated by
 * the same secret `X-Admin-Token`. Pages through the bucket with R2's list
 * cursor; for each PNG/JPEG object it decodes, encodes to WEBP, and overwrites
 * the SAME key (the content hash stays the doc's reference) with a
 * Content-Type of image/webp — but only when the WEBP is actually smaller.
 *
 * Already-WEBP objects (and formats we can't transcode) are skipped, so this is
 * idempotent: a second pass converts nothing.
 *
 * Note: GET /images/:hash responses are edge-cached `immutable`, so any colo
 * that already cached an object will keep serving the pre-conversion bytes until
 * its cache evicts. We best-effort delete the current colo's cache entry; the
 * bytes are visually identical regardless, so this only delays the size win.
 *
 *   body: { cursor?: string (object-store list cursor), limit?: number (default 10) }
 *   ->    { processed, converted, skipped, nextCursor }  (nextCursor null at end)
 */
export async function handleAdminBackfillWebp(request, env, ctx, cors) {
	if (request.method !== 'POST') return textResponse('Method not allowed.', 405, cors);
	if (!env.ADMIN_MIGRATE_TOKEN) return textResponse('Server misconfiguration: ADMIN_MIGRATE_TOKEN not set', 500, cors);
	const images = imageStore(env);
	if (!images) return textResponse('Image store is not configured.', 500, cors);

	const provided = request.headers.get('X-Admin-Token') || '';
	if (!timingSafeEqual(provided, env.ADMIN_MIGRATE_TOKEN)) {
		return textResponse('Forbidden.', 403, cors);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		body = {};
	}
	// Each object is a decode+encode (CPU-heavy), so page in small batches.
	const limit = Math.max(1, Math.min(Number(body.limit) || 10, 50));
	const cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : undefined;

	let listing;
	try {
		listing = await images.list({ limit, cursor });
	} catch (e) {
		return textResponse('Could not list the image store.', 502, cors);
	}

	let converted = 0;
	let skipped = 0;
	for (const obj of listing.objects) {
		const contentType = (obj.contentType || '').toLowerCase();
		// Only raster formats convertImageToWebp knows how to decode; everything
		// else (already-webp, gif, svg, bmp, unknown) is left as-is.
		if (contentType !== 'image/png' && contentType !== 'image/jpeg' && contentType !== 'image/jpg') {
			skipped += 1;
			continue;
		}
		const stored = await images.get(obj.key);
		if (!stored) {
			skipped += 1;
			continue;
		}
		const bytes = await stored.bytes();
		const result = await convertImageToWebp(bytes, contentType);
		// convertImageToWebp returns the original (same bytes) when WEBP wasn't
		// smaller or decoding failed — only rewrite when it actually shrank.
		if (result.contentType === 'image/webp') {
			await images.put(obj.key, result.bytes, { contentType: 'image/webp' });
			// Best-effort: drop the cached (pre-conversion) copy.
			const cacheKey = new URL(`/images/${obj.key}`, request.url).toString();
			ctx.waitUntil(responseCache(env).delete(cacheKey));
			converted += 1;
		} else {
			skipped += 1;
		}
	}

	const nextCursor = listing.truncated ? listing.cursor : null;
	return jsonResponse({ processed: listing.objects.length, converted, skipped, nextCursor }, 200, cors);
}
