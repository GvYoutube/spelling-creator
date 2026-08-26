// GET /spelling-words.json — a flat list of every spelling word taught across the
// published lessons on the hub, used by the marketing homepage's floating-words
// animation (see apps/web/src/components/FloatingWords.jsx).
//
// Building this means fetching and scanning every published lesson's full doc,
// which is far heavier than the other read routes — so the result is cached in KV
// and only rebuilt once every REFRESH_DAYS days. Within that window every request
// returns the same precomputed JSON straight from KV. The cached payload also
// carries `generatedAt` so a client (or a curious human) can see how stale it is.

import { supabaseHeaders } from '../lib/supabase.js';
import { rateLimitStore } from '../platform/index.js';
import { jsonResponse, textResponse } from '../lib/http.js';

// How often the aggregate is allowed to change. The KV entry is written with this
// as its TTL, so once it expires the next request rebuilds it — giving the
// "updates at most every 2 days" guarantee without a scheduled job.
const REFRESH_DAYS = 2;
const REFRESH_SECONDS = REFRESH_DAYS * 24 * 60 * 60;

// KV key for the cached payload. Bump the version suffix if the shape changes.
const CACHE_KEY = 'spelling-words:v1';

// Bound the work and the payload: scan at most this many lessons, and return at
// most this many distinct words (plenty for the animation, which only shows a
// few dozen at a time).
const MAX_LESSONS = 500;
const MAX_WORDS = 600;

/**
 * Pull every spelling word out of an editor doc, in reading order. Spelling
 * blocks have the shape { type: "spelling", words: [{ id, text }] } (see
 * apps/web/src/lib/spelling.js); we read each row's trimmed `text`.
 */
function wordsFromDoc(doc) {
	const out = [];
	const sections = doc && Array.isArray(doc.sections) ? doc.sections : [];
	for (const section of sections) {
		const blocks = section && Array.isArray(section.blocks) ? section.blocks : [];
		for (const block of blocks) {
			if (!block || block.type !== 'spelling' || !Array.isArray(block.words)) continue;
			for (const word of block.words) {
				const text = (word && typeof word.text === 'string' ? word.text : '').trim();
				if (text) out.push(text);
			}
		}
	}
	return out;
}

/**
 * Rebuild the aggregate by scanning every published, non-shadowbanned lesson's
 * doc. Words are de-duplicated case-insensitively (keeping the first casing seen)
 * and the list is capped. Returns { generatedAt, count, words } or null if the
 * store couldn't be reached (so the caller can fall back to a stale/empty payload
 * rather than caching a broken result).
 */
async function buildAggregate(env, base, now) {
	const query = `published=eq.true&shadowbanned=eq.false&select=doc&order=created_at.desc&limit=${MAX_LESSONS}`;
	let res;
	try {
		res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	const rows = await res.json().catch(() => null);
	if (!Array.isArray(rows)) return null;

	const seen = new Set();
	const words = [];
	for (const row of rows) {
		for (const word of wordsFromDoc(row && row.doc)) {
			const key = word.toLocaleLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			words.push(word);
			if (words.length >= MAX_WORDS) break;
		}
		if (words.length >= MAX_WORDS) break;
	}

	return { generatedAt: new Date(now).toISOString(), count: words.length, words };
}

/**
 * GET /spelling-words.json — the cached aggregate. Served from KV when present;
 * rebuilt (and re-cached for REFRESH_DAYS days) when the cache is empty or expired.
 * On a Supabase hiccup during a rebuild we return a valid, empty payload rather
 * than failing — matching the sitemap/feed routes.
 */
export async function handleSpellingWords(request, env, url, cors) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return textResponse('Method not allowed.', 405, cors);
	}

	const now = Date.now();
	const headers = new Headers(cors);
	headers.set('Content-Type', 'application/json; charset=utf-8');
	// Browsers/CDNs may also hold the response for the refresh window.
	headers.set('Cache-Control', `public, max-age=${REFRESH_SECONDS}`);

	// 1) Serve the cached payload if the entry is still alive.
	const kv = rateLimitStore(env);
	if (kv) {
		const cached = await kv.get(CACHE_KEY).catch(() => null);
		if (cached) {
			return new Response(cached, { status: 200, headers });
		}
	}

	// 2) Cache miss (or no key-value store): rebuild from Supabase.
	let payload = null;
	if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
		const base = env.SUPABASE_URL.replace(/\/$/, '');
		payload = await buildAggregate(env, base, now);
	}

	// Supabase unreachable or unconfigured: serve a valid empty payload, and don't
	// poison the cache with it (so the next request retries the rebuild).
	if (!payload) {
		return jsonResponse({ generatedAt: new Date(now).toISOString(), count: 0, words: [] }, 200, cors);
	}

	const body = JSON.stringify(payload);
	if (kv) {
		// Expire after the refresh window so the next request past it rebuilds.
		await kv.put(CACHE_KEY, body, { expirationTtl: REFRESH_SECONDS }).catch(() => {});
	}
	return new Response(body, { status: 200, headers });
}
