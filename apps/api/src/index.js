import { env } from 'cloudflare:workers';
import puppeteer from '@cloudflare/puppeteer';
import { GoogleGenAI, Type } from '@google/genai';
import { Filter } from 'glin-profanity';

const GEMINI_API_KEY = env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Models to try, newest first. If a model is unavailable or errors (e.g. not yet
// rolled out to this key), we fall back to the next one in order.
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash'];

// Run generateContent against GEMINI_MODELS in order, returning the first success.
// Throws the last error only if every model fails.
async function generateContentWithFallback(request) {
	let lastErr;
	for (const model of GEMINI_MODELS) {
		try {
			return await ai.models.generateContent({ ...request, model });
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

// Shared profanity filter for moderating lesson comments. Built once (it compiles
// its word list into a regex) and reused across requests. `checkProfanity(text)`
// returns { containsProfanity, profaneWords }; we reject a comment outright when
// containsProfanity is true rather than censoring individual words.
const profanityFilter = new Filter();

const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Structured-output schemas for the question suggester, one per question type.
// They mirror the block shapes the editor builds in src/lib/questions.js:
// buildQuestionBlock maps this JSON onto the editable block (e.g. wrapping each
// "multiple" answer string in an { id, text } row).
const QUESTION_SCHEMAS = {
	number: {
		type: Type.OBJECT,
		properties: { prompt: { type: Type.STRING }, answer: { type: Type.NUMBER } },
		required: ['prompt', 'answer'],
	},
	single: {
		type: Type.OBJECT,
		properties: {
			prompt: { type: Type.STRING },
			answer: { type: Type.STRING },
		},
		required: ['prompt', 'answer'],
	},
	multiple: {
		type: Type.OBJECT,
		properties: {
			prompt: { type: Type.STRING },
			answers: { type: Type.ARRAY, items: { type: Type.STRING } },
		},
		required: ['prompt', 'answers'],
	},
	open: {
		type: Type.OBJECT,
		properties: { prompt: { type: Type.STRING }, exampleAnswer: { type: Type.STRING } },
		required: ['prompt', 'exampleAnswer'],
	},
	background: {
		type: Type.OBJECT,
		properties: {
			prompt: { type: Type.STRING },
			background: { type: Type.STRING },
			answer: { type: Type.STRING },
		},
		required: ['prompt', 'background', 'answer'],
	},
};

// How to describe each question type in the prompt, and the type-specific rules
// the model must follow so its JSON matches the schema above.
const QUESTION_LABELS = {
	number: 'number-answer',
	single: 'single-answer',
	multiple: 'multiple-answer',
	open: 'open-ended',
	background: 'background-knowledge',
};

const QUESTION_INSTRUCTIONS = {
	number: 'The question must have a single numeric answer. Put that number in the "answer" field.',
	single:
		'The question must have a single short typed answer (a word or brief phrase). Do not make the answer a number under any circumstances. Do not provide answer options. Put the correct answer in "answer".',
	multiple:
		'The question must have several distinct correct answers, any one of which a student could type to be marked correct (the student only needs to give one). If you generate a single answer, consider that a failure. Do not provide answer options. Put each accepted answer as a separate string in "answers".',
	open: 'Write a question that invites a free, written response. Do not provide answer options. Put the question in "prompt" and a concise example of a good answer (a model response a teacher could mark against) in "exampleAnswer".',
	background:
		'The question must test prior knowledge that is NOT explained anywhere in the lesson text — the student is expected to already know it. Do not ask about anything the lesson text covers. Put the question in "prompt", a short paragraph of the prior knowledge a student needs to answer it in "background", and the correct answer (a word or brief phrase) in "answer".',
};

// How long a cached AI answer lives in KV.
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

// The request modes this Worker understands. "text"/"question" drive the AI
// suggesters; "imageSearch"/"imageFetch" drive the Pixabay image search. Any
// unknown mode falls back to "text".
const KNOWN_MODES = new Set(['text', 'question', 'imageSearch', 'imageFetch', 'lessonIdea']);

// Structured-output schema for the lesson-idea suggester: a short list of lesson
// topic ideas pitched at an age range, each with a title the user can adopt as
// their lesson title and a one-line description of what it would cover.
const LESSON_IDEA_SCHEMA = {
	type: Type.OBJECT,
	properties: {
		ideas: {
			type: Type.ARRAY,
			items: {
				type: Type.OBJECT,
				properties: {
					title: { type: Type.STRING },
					description: { type: Type.STRING },
				},
				required: ['title', 'description'],
			},
		},
	},
	required: ['ideas'],
};

// The only hosts the image proxy will ever fetch from — an SSRF guard so a
// crafted `url` can't make the Worker fetch arbitrary internal/external targets.
const PIXABAY_HOSTS = new Set(['pixabay.com', 'cdn.pixabay.com']);

/**
 * Build a plain-text error Response carrying the request's CORS headers. The
 * client surfaces `res.text()` directly, so the message is user-facing.
 */
function textResponse(msg, status, cors) {
	const headers = new Headers(cors);
	headers.set('Content-Type', 'text/plain');
	return new Response(msg, { status, headers });
}

/**
 * Search Pixabay for photos matching `query` and return normalised hits. The
 * Pixabay API key lives only on the Worker, so the browser never sees it. The
 * upstream response is edge-cached for 24h, which both satisfies Pixabay's
 * caching requirement and keeps repeated identical searches off the API (well
 * under its 100 req/min limit). `okHeaders()` carries CORS + the rate-limit
 * budget; `cors` is reused for error responses.
 */
async function handleImageSearch(query, page, perPage, env, okHeaders, cors) {
	const q = (query || '').trim();
	if (!q) return textResponse('Missing search query.', 400, cors);
	if (!env.PIXABAY_API_KEY) return textResponse('Server misconfiguration: PIXABAY_API_KEY not set', 500, cors);

	const p = Math.max(1, Math.min(Number(page) || 1, 100));
	const pp = Math.max(3, Math.min(Number(perPage) || 20, 50));

	const url = new URL('https://pixabay.com/api/');
	url.searchParams.set('key', env.PIXABAY_API_KEY);
	url.searchParams.set('q', q);
	url.searchParams.set('image_type', 'photo');
	url.searchParams.set('safesearch', 'true'); // school-friendly
	url.searchParams.set('per_page', String(pp));
	url.searchParams.set('page', String(p));

	let res;
	try {
		res = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
	} catch (e) {
		return textResponse('Image search failed upstream.', 502, cors);
	}

	// Honour Pixabay's rate-limit headers — back off cleanly instead of erroring.
	if (res.status === 429) {
		const reset = res.headers.get('X-RateLimit-Reset') || '60';
		return textResponse(`Image search is busy. Try again in ${reset}s.`, 429, cors);
	}
	if (!res.ok) return textResponse('Image search failed upstream.', 502, cors);

	let data;
	try {
		data = await res.json();
	} catch (e) {
		return textResponse('Image search failed upstream.', 502, cors);
	}

	const hits = (data.hits || []).map((h) => ({
		id: h.id,
		previewURL: h.previewURL,
		webformatURL: h.webformatURL,
		webformatWidth: h.webformatWidth,
		webformatHeight: h.webformatHeight,
		tags: h.tags,
		user: h.user,
		pageURL: h.pageURL,
	}));
	return new Response(JSON.stringify({ hits, total: data.total, totalHits: data.totalHits }), { status: 200, headers: okHeaders() });
}

/**
 * Download a single Pixabay image through the Worker and return it as a data
 * URL. The browser can't read the bytes itself because Pixabay's image CDN
 * sends no CORS headers; embedding the bytes as a data URL also means the image
 * is copied into the document at insert time and never hotlinked. An SSRF guard
 * restricts the fetch to https Pixabay hosts only.
 */
async function handleImageFetch(rawUrl, okHeaders, cors) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch (e) {
		return textResponse('Invalid image URL.', 400, cors);
	}
	if (url.protocol !== 'https:' || !PIXABAY_HOSTS.has(url.hostname)) {
		return textResponse('Only Pixabay image URLs are allowed.', 400, cors);
	}

	let res;
	try {
		res = await fetch(url.toString(), { cf: { cacheTtl: 86400, cacheEverything: true } });
	} catch (e) {
		return textResponse('Could not download the image.', 502, cors);
	}
	if (!res.ok) return textResponse('Could not download the image.', 502, cors);

	const contentType = res.headers.get('Content-Type') || 'image/jpeg';
	if (!contentType.startsWith('image/')) {
		return textResponse('That URL is not an image.', 400, cors);
	}

	// webformat images are small (~50-250 KB); base64 in one pass is fine.
	const bytes = new Uint8Array(await res.arrayBuffer());
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	const dataUrl = `data:${contentType};base64,${btoa(binary)}`;
	return new Response(JSON.stringify({ dataUrl }), { status: 200, headers: okHeaders() });
}

// A valid image object key is a 64-char lowercase hex SHA-256.
const IMAGE_HASH_RE = /^[0-9a-f]{64}$/;
// Cap a single image so one PUT can't fill the bucket (also mirrored client-side).
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Lowercase hex SHA-256 of the given bytes — matches the hash the browser
// computes (web/src/lib/imageStore.js) so a content-addressed object key is
// verifiable from its bytes.
async function sha256Hex(bytes) {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * GET/HEAD /images/:hash — serve a lesson image from R2 by its content hash.
 * Public: published lessons are viewed by anyone, and the og-image/prerender
 * headless browser fetches these too. Content-addressed, so the bytes for a
 * given hash never change — the response is immutable and cached forever. 404
 * when the object isn't present.
 */
async function handleImageGet(request, env, ctx, hash) {
	// Images are public; a static `*` ACAO is cache-safe (no per-origin variance,
	// so one cached copy serves everyone) and lets cross-origin reads work too
	// (e.g. the export byte-fetch when the SPA origin differs from the API).
	const ACAO = { 'Access-Control-Allow-Origin': '*' };
	if (!env.IMAGES) return new Response('Image store is not configured.', { status: 500, headers: ACAO });
	if (!IMAGE_HASH_RE.test(hash)) return new Response('Invalid image id.', { status: 400, headers: ACAO });

	// Content-addressed and immutable: the bytes for a given hash never change, so
	// cache the response at Cloudflare's edge. Repeat reads — every public lesson
	// view, the og-image/prerender browser, export byte-fetches — are then served
	// from cache and DON'T each cost an R2 class-B operation (key to staying in
	// the free tier under traffic).
	const cache = caches.default;
	const cacheKey = new Request(new URL(`/images/${hash}`, request.url).toString());
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
		const meta = await env.IMAGES.head(hash);
		if (!meta) return new Response('Image not found.', { status: 404, headers: ACAO });
		const headers = new Headers(baseHeaders);
		headers.set('Content-Type', meta.httpMetadata?.contentType || 'application/octet-stream');
		if (meta.httpEtag) headers.set('ETag', meta.httpEtag);
		return new Response(null, { status: 200, headers });
	}

	const object = await env.IMAGES.get(hash);
	if (!object) return new Response('Image not found.', { status: 404, headers: ACAO });
	const headers = new Headers(baseHeaders);
	headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
	if (object.httpEtag) headers.set('ETag', object.httpEtag);
	const response = new Response(object.body, { status: 200, headers });
	// Populate the edge cache for subsequent reads of this immutable object.
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

/**
 * PUT /images/:hash — store a lesson image in R2. Requires a verified Supabase
 * session (so anonymous callers can't fill the bucket), and verifies the body's
 * SHA-256 equals :hash so a caller can't store arbitrary content at a key they
 * don't control. Idempotent — re-uploading identical bytes is a harmless no-op.
 */
async function handleImagePut(request, env, hash, cors) {
	if (!env.IMAGES) return textResponse('Image store is not configured.', 500, cors);
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

	// Idempotent: an existing object with this key already holds identical bytes.
	const existing = await env.IMAGES.head(hash);
	if (!existing) {
		await env.IMAGES.put(hash, bytes, { httpMetadata: { contentType } });
	}
	return jsonResponse({ ok: true }, 200, cors);
}

// docx ext rules, mirroring web/src/lib/imageRef.js extFromMime.
function extFromMime(mime) {
	const raw = (mime || '').toLowerCase().replace(/^image\//, '');
	if (raw === 'jpeg') return 'jpg';
	if (raw === 'svg+xml') return 'png';
	if (['png', 'jpg', 'gif', 'bmp'].includes(raw)) return raw;
	return 'png';
}

// Split a base64/percent-encoded data URL into raw bytes + mime (server side).
function decodeDataUrl(dataUrl) {
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
			const existing = await env.IMAGES.head(hash);
			if (!existing) {
				await env.IMAGES.put(hash, decoded.bytes, { httpMetadata: { contentType: decoded.mime } });
			}
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
async function handleAdminMigrateImages(request, env, cors) {
	if (request.method !== 'POST') return textResponse('Method not allowed.', 405, cors);
	if (!env.ADMIN_MIGRATE_TOKEN) return textResponse('Server misconfiguration: ADMIN_MIGRATE_TOKEN not set', 500, cors);
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (!env.IMAGES) return textResponse('Image store is not configured.', 500, cors);

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
 * Build a stable, case-insensitive cache key from the inputs that actually
 * determine the AI answer. Each part is trimmed and lower-cased before hashing,
 * so the same information in different casing or with surrounding whitespace
 * maps to the same entry. The Turnstile token and client IP are deliberately
 * excluded — they gate access but do not change the generated content. The
 * inputs are hashed (rather than concatenated) so the key stays within KV's
 * key-length limit even when `sectionText` is long.
 */
async function cacheKey(parts) {
	const norm = parts
		.map((p) =>
			String(p ?? '')
				.trim()
				.toLowerCase(),
		)
		.join(' ');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `cache:${hex}`;
}

/**
 * Verify a Cloudflare Turnstile token server-side.
 *
 * Returns { ok: true } only when Cloudflare confirms the token is valid AND the
 * `hostname` Cloudflare reports the challenge was solved on is in the allow-list.
 * The hostname comes from the verified siteverify response — it is bound by
 * Cloudflare to where the widget ran, so unlike the Origin/Referer headers it
 * cannot be forged by the client. This is what proves the request came from our
 * own domain. On any failure returns { ok: false, status, reason }.
 */
async function verifyTurnstile(token, secret, allowedHostnames, remoteIp) {
	if (!secret) {
		return { ok: false, status: 500, reason: 'Server misconfiguration: TURNSTILE_SECRET_KEY not set' };
	}
	if (!allowedHostnames || allowedHostnames.length === 0) {
		return { ok: false, status: 500, reason: 'Server misconfiguration: ALLOWED_HOSTNAMES not set' };
	}
	if (!token) {
		return { ok: false, status: 403, reason: 'Missing Turnstile token' };
	}

	const form = new URLSearchParams();
	form.set('secret', secret);
	form.set('response', token);
	if (remoteIp && remoteIp !== 'unknown') form.set('remoteip', remoteIp);

	let outcome;
	try {
		const resp = await fetch(TURNSTILE_SITEVERIFY_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form,
		});
		outcome = await resp.json();
	} catch (e) {
		return { ok: false, status: 502, reason: 'Turnstile verification unavailable' };
	}

	if (!outcome.success) {
		// The widget can show "Success!" client-side (it only checks the sitekey)
		// while siteverify still rejects. The `error-codes` tell us why, so surface
		// and log them instead of collapsing every cause into one opaque message.
		const codes = Array.isArray(outcome['error-codes']) ? outcome['error-codes'] : [];
		console.warn('Turnstile siteverify rejected token', { codes, hostname: outcome.hostname });

		// A wrong/mismatched secret fails for EVERY token, regardless of how many
		// times the user re-solves — it's a server config error, not the user's
		// fault, so report it as a 500 with a precise, fixable reason.
		if (codes.includes('invalid-input-secret') || codes.includes('bad-request')) {
			return {
				ok: false,
				status: 500,
				reason: 'Server misconfiguration: TURNSTILE_SECRET_KEY does not match the site key',
			};
		}
		// The token was already used or has expired (single-use, ~300s lifetime).
		// The widget often still shows a stale "Success!" here; ask for a fresh one.
		if (codes.includes('timeout-or-duplicate') || codes.includes('invalid-input-response')) {
			return {
				ok: false,
				status: 403,
				reason: 'Verification expired — please re-verify and try again',
			};
		}
		const detail = codes.length ? ` (${codes.join(', ')})` : '';
		return { ok: false, status: 403, reason: `Turnstile verification failed${detail}` };
	}
	if (!allowedHostnames.includes(outcome.hostname)) {
		return { ok: false, status: 403, reason: 'Request did not originate from an allowed domain' };
	}

	return { ok: true };
}

/**
 * Build CORS headers for a request. The Origin is reflected back only when its
 * hostname is in the allow-list, so the browser permits cross-origin reads from
 * our own domain(s) but not from arbitrary sites.
 */
function corsHeaders(request, allowedHostnames) {
	const headers = new Headers();
	const origin = request.headers.get('Origin');
	if (origin) {
		let allowed;
		try {
			allowed = allowedHostnames.includes(new URL(origin).hostname);
		} catch {
			allowed = false;
		}
		if (allowed) {
			headers.set('Access-Control-Allow-Origin', origin);
			headers.set('Vary', 'Origin');
			headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
			headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
			headers.set('Access-Control-Max-Age', '86400');
		}
	}
	return headers;
}

/**
 * Build a JSON Response carrying the request's CORS headers. Used by the lesson
 * hub endpoints, which return JSON on success and plain text (via textResponse)
 * on error — matching the AI/Pixabay convention the frontend already surfaces.
 */
function jsonResponse(obj, status, cors) {
	const headers = new Headers(cors);
	headers.set('Content-Type', 'application/json');
	return new Response(JSON.stringify(obj), { status, headers });
}

/**
 * Headers for talking to Supabase's REST (PostgREST) and Auth APIs with the
 * service-role key. The service-role key bypasses RLS, so it lives only on the
 * Worker and is never shipped to the browser.
 */
function supabaseHeaders(env) {
	return {
		apikey: env.SUPABASE_SERVICE_ROLE_KEY,
		Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
	};
}

/**
 * Verify a Supabase session JWT by asking Supabase Auth who it belongs to.
 *
 * We call GET /auth/v1/user with the client-supplied token rather than checking
 * an HS256 signature ourselves: it needs no JWT secret, and it keeps working if
 * the project switches to asymmetric (RS256/ES256) signing keys. Returns the
 * verified user object on success, or null if the token is missing/invalid.
 */
async function verifySupabaseUser(env, token) {
	if (!token) return null;
	let res;
	try {
		res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
			headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
		});
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	const user = await res.json().catch(() => null);
	return user && user.id ? user : null;
}

/**
 * Pick a human-friendly author label from a verified Supabase user. Prefers a
 * name from the user's metadata, falling back to the email so the hub listing
 * always has something to show. The author is taken from the verified user, never
 * from client-supplied input.
 */
function authorFromUser(user) {
	const meta = user.user_metadata || {};
	return meta.full_name || meta.name || user.email || 'Anonymous';
}

/**
 * Map a Supabase `lessons` row to the camelCase summary the frontend expects.
 * `withDoc` includes the full editor document (used by the single-lesson fetch).
 */
function rowToLesson(row, withDoc) {
	const lesson = {
		id: row.id,
		// The author's Supabase user id — the frontend compares it with the
		// signed-in user to decide whether to offer an "Edit" action. (The author
		// display name lives separately in `author`.)
		authorId: row.author_id,
		title: row.title,
		author: row.author,
		sectionCount: row.section_count ?? 0,
		// Whether the lesson is shared on the public hub. `false` is a draft, backed
		// up to the database but visible only to its author. Defaults to true so a
		// row from a database that predates the `published` column reads as published.
		published: row.published ?? true,
		createdAt: row.created_at,
	};
	if (withDoc) lesson.doc = row.doc;
	return lesson;
}

/**
 * Lesson-hub endpoints, backed by Supabase Postgres via its REST API. The
 * browser never touches the database directly — it calls these Worker routes,
 * which hold the privileged service-role key (see README "Lesson hub").
 *
 *   GET  /lessons        public  -> { lessons: LessonSummary[] }   (published only, newest first)
 *   GET  /lessons/mine   Bearer  -> { lessons: LessonSummary[] }   (caller's own, incl. drafts)
 *   GET  /lessons/:id    public  -> { lesson: Lesson }             (includes doc; drafts too)
 *   POST /lessons        Bearer  -> { lesson: LessonSummary }      (verified JWT; body.published picks draft/hub)
 *   PUT  /lessons/:id    Bearer  -> { lesson: LessonSummary }      (author only; body.published may flip draft<->hub)
 *
 * A LessonSummary carries `published` (false = draft, kept out of the public listing).
 * Errors are short plain-text reasons so the frontend can surface res.text().
 */
async function handleLessons(request, env, url, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}

	const base = env.SUPABASE_URL.replace(/\/$/, '');
	// Everything after "/lessons": "" for the collection, "/<id>" for one lesson.
	const rest = url.pathname.replace(/\/$/, '').slice('/lessons'.length);
	const id = rest.startsWith('/') ? decodeURIComponent(rest.slice(1)) : '';

	// GET /lessons/mine — the signed-in user's own lessons (drafts and published),
	// newest first, so the hub can show them their drafts. Requires a valid Supabase
	// session JWT; the listing is scoped to the verified user's own rows. The doc is
	// excluded (as in the public listing) to keep the payload small.
	if (request.method === 'GET' && id === 'mine') {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in to see your lessons.', 401, cors);

		const query = `author_id=eq.${encodeURIComponent(
			user.id,
		)}&select=id,author_id,title,author,section_count,published,created_at&order=created_at.desc`;
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load your lessons.', 502, cors);
		const rows = await res.json().catch(() => []);
		const lessons = (Array.isArray(rows) ? rows : []).map((r) => rowToLesson(r, false));
		return jsonResponse({ lessons }, 200, cors);
	}

	// GET /lessons/:id — one lesson, including its full editor doc. Returns drafts
	// too (so an author can load one for editing, and an unlisted-style link works);
	// drafts are kept out of the public *listing* below, not addressable-by-id reads.
	if (request.method === 'GET' && id) {
		const query = `id=eq.${encodeURIComponent(id)}&select=id,author_id,title,author,section_count,published,created_at,doc&limit=1`;
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Lesson not found.', 404, cors);
		}
		return jsonResponse({ lesson: rowToLesson(rows[0], true) }, 200, cors);
	}

	// GET /lessons — public listing, newest first. Only published lessons appear;
	// drafts (published = false) are filtered out so they stay private to their
	// author. The doc (which can be large, holding base64 image data) is deliberately
	// excluded; section_count gives the summary its count without shipping every block.
	if (request.method === 'GET') {
		const query = 'published=eq.true&select=id,author_id,title,author,section_count,published,created_at&order=created_at.desc';
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load lessons.', 502, cors);
		const rows = await res.json().catch(() => []);
		const lessons = (Array.isArray(rows) ? rows : []).map((r) => rowToLesson(r, false));
		return jsonResponse({ lessons }, 200, cors);
	}

	// POST /lessons — save a lesson to the cloud. Requires a valid Supabase session
	// JWT; the author is derived from the verified user, never from the request body.
	// `published` selects whether the lesson is shared on the public hub (true) or
	// kept as a private draft backup (false); it defaults to true so an older client
	// that omits the flag still publishes.
	if (request.method === 'POST' && !id) {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in before saving.', 401, cors);

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const doc = body && body.doc;
		if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sections) || doc.sections.length === 0) {
			return textResponse('Add at least one section before saving.', 400, cors);
		}
		const title = (body.title || doc.title || 'Untitled Lesson').toString().slice(0, 300);
		const published = body.published !== false;

		const insert = {
			author_id: user.id,
			author: authorFromUser(user),
			title,
			doc,
			published,
		};

		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?select=id,author_id,title,author,section_count,published,created_at`, {
				method: 'POST',
				headers: {
					...supabaseHeaders(env),
					'Content-Type': 'application/json',
					Prefer: 'return=representation',
				},
				body: JSON.stringify(insert),
			});
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not save the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Could not save the lesson.', 502, cors);
		}
		return jsonResponse({ lesson: rowToLesson(rows[0], false) }, 201, cors);
	}

	// PUT /lessons/:id — update a lesson the signed-in user already saved to the
	// cloud. Requires a valid Supabase session JWT, and the verified user must be the
	// lesson's author: the PATCH is filtered on both id AND author_id, so a
	// request from anyone other than the author matches no rows and is rejected
	// with 403. The title, doc and published flag are mutable (so a draft can be
	// published, or a published lesson pulled back to a draft); author and created_at
	// stay put. `published` is only changed when the body includes a boolean for it,
	// so an older client that omits it leaves the lesson's current state alone.
	if (request.method === 'PUT' && id) {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in before editing.', 401, cors);

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const doc = body && body.doc;
		if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sections) || doc.sections.length === 0) {
			return textResponse('Add at least one section before saving.', 400, cors);
		}
		const title = (body.title || doc.title || 'Untitled Lesson').toString().slice(0, 300);
		const patch = { title, doc };
		if (typeof body.published === 'boolean') patch.published = body.published;

		let res;
		try {
			res = await fetch(
				`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(id)}&author_id=eq.${encodeURIComponent(
					user.id,
				)}&select=id,author_id,title,author,section_count,published,created_at`,
				{
					method: 'PATCH',
					headers: {
						...supabaseHeaders(env),
						'Content-Type': 'application/json',
						Prefer: 'return=representation',
					},
					body: JSON.stringify(patch),
				},
			);
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not save the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		// No row matched id+author_id: the lesson doesn't exist, or it isn't the
		// signed-in user's to edit. Either way, don't reveal which.
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('You can only edit lessons you published.', 403, cors);
		}
		return jsonResponse({ lesson: rowToLesson(rows[0], false) }, 200, cors);
	}

	// DELETE /lessons/:id — remove a lesson the signed-in user published. Requires
	// a valid Supabase session JWT, and the verified user must be the lesson's
	// author.
	//
	// A lesson may have comments, which carry a foreign key to it. schema.sql
	// declares that FK `on delete cascade`, but a database created before that
	// cascade was added wouldn't have it — there, deleting a lesson that still has
	// comments would fail. So we do it in three ownership-gated steps that work
	// regardless of the deployed constraint: (1) confirm the lesson is the caller's
	// (filtering on id AND author_id — a non-owner matches nothing and gets 403),
	// (2) clear its comments, (3) delete the lesson. Step 2 is a harmless no-op
	// when the FK already cascades.
	if (request.method === 'DELETE' && id) {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in before deleting.', 401, cors);

		// (1) Ownership check. We must confirm the lesson is the caller's before
		// touching its comments, since the comment delete below can't itself filter
		// on the lesson's author.
		let ownRes;
		try {
			ownRes = await fetch(
				`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(id)}&author_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`,
				{ headers: supabaseHeaders(env) },
			);
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!ownRes.ok) return textResponse('Could not delete the lesson.', 502, cors);
		const ownRows = await ownRes.json().catch(() => []);
		// No row matched id+author_id: the lesson doesn't exist, or it isn't the
		// signed-in user's to delete. Either way, don't reveal which.
		if (!Array.isArray(ownRows) || ownRows.length === 0) {
			return textResponse('You can only delete lessons you published.', 403, cors);
		}

		// (2) Clear the lesson's comments so the lesson delete can't be blocked by
		// the FK on a non-cascading database.
		let commentsRes;
		try {
			commentsRes = await fetch(`${base}/rest/v1/comments?lesson_id=eq.${encodeURIComponent(id)}`, {
				method: 'DELETE',
				headers: supabaseHeaders(env),
			});
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!commentsRes.ok) return textResponse('Could not delete the lesson.', 502, cors);

		// (3) Delete the lesson itself (still filtered on author_id as defence in
		// depth). return=representation lets us confirm a row was actually removed.
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(id)}&author_id=eq.${encodeURIComponent(user.id)}&select=id`, {
				method: 'DELETE',
				headers: {
					...supabaseHeaders(env),
					Prefer: 'return=representation',
				},
			});
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not delete the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('You can only delete lessons you published.', 403, cors);
		}
		return jsonResponse({ ok: true }, 200, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}

// The longest comment we accept. Comments are short discussion, not documents.
const MAX_COMMENT_LENGTH = 2000;

/**
 * Map a Supabase `comments` row to the camelCase shape the frontend expects.
 */
function rowToComment(row) {
	return {
		id: row.id,
		// The comment this one replies to, or null for a top-level comment. The
		// frontend uses it to nest replies under their parent.
		parentId: row.parent_id || null,
		author: row.author,
		body: row.body,
		createdAt: row.created_at,
	};
}

/**
 * Comment endpoints for a single published lesson, backed by Supabase Postgres.
 *
 *   GET  /lessons/:id/comments   public  -> { comments: Comment[] }   (oldest first)
 *   POST /lessons/:id/comments   Bearer  -> { comment: Comment }      (verified JWT)
 *
 * POST is moderated: the comment text is run through glin-profanity, and if it
 * contains any profanity the whole comment is rejected (422) — nothing is stored
 * and nothing is censored-and-kept. The author is derived from the verified user,
 * never from the request body. Errors are short plain-text reasons so the frontend
 * can surface res.text(), matching the rest of the API.
 *
 * A POST may carry `parentId` to reply to an existing comment on the same lesson.
 * When it does, the reply notifies the parent comment's author and the lesson's
 * author (deduplicated to a single notification when they're the same person, and
 * never notifying the replier themselves). Notification failures are swallowed so
 * they can't fail the reply itself.
 */
async function handleComments(request, env, lessonId, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (!lessonId) return textResponse('Missing lesson id.', 400, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');

	// GET — public listing of a lesson's comments, oldest first so the thread
	// reads top to bottom.
	if (request.method === 'GET') {
		const query = `lesson_id=eq.${encodeURIComponent(lessonId)}&select=id,parent_id,author,body,created_at&order=created_at.asc`;
		let res;
		try {
			res = await fetch(`${base}/rest/v1/comments?${query}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return textResponse('Could not reach the comment store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load comments.', 502, cors);
		const rows = await res.json().catch(() => []);
		const comments = (Array.isArray(rows) ? rows : []).map(rowToComment);
		return jsonResponse({ comments }, 200, cors);
	}

	// POST — add a comment. Requires a valid Supabase session JWT.
	if (request.method === 'POST') {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in before commenting.', 401, cors);

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const text = (body && typeof body.body === 'string' ? body.body : '').trim();
		if (!text) return textResponse('Write something before posting.', 400, cors);
		if (text.length > MAX_COMMENT_LENGTH) {
			return textResponse(`Comments are limited to ${MAX_COMMENT_LENGTH} characters.`, 400, cors);
		}

		// Optional: the comment being replied to. Empty/missing means a top-level
		// comment. We validate it (below) belongs to this lesson before inserting.
		const parentId = (body && body.parentId ? String(body.parentId) : '').trim();

		// Moderation: block the entire comment if it contains profanity. Done
		// server-side so it can't be bypassed by a crafted client request.
		if (profanityFilter.checkProfanity(text).containsProfanity) {
			return textResponse('This comment contains language that isn’t allowed. Please revise it and try again.', 422, cors);
		}

		// The lesson must exist; the FK would reject an orphan comment anyway, but
		// checking first lets us return a clear 404 instead of a generic store error.
		let lessonRes;
		try {
			lessonRes = await fetch(`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(lessonId)}&select=id,author_id,title&limit=1`, {
				headers: supabaseHeaders(env),
			});
		} catch (e) {
			return textResponse('Could not reach the comment store.', 502, cors);
		}
		const lessonRows = lessonRes.ok ? await lessonRes.json().catch(() => []) : [];
		if (!Array.isArray(lessonRows) || lessonRows.length === 0) {
			return textResponse('Lesson not found.', 404, cors);
		}
		const lesson = lessonRows[0];

		// If this is a reply, the parent must exist and belong to the same lesson.
		// We grab its author_id so we can notify that person once the reply lands.
		let parentComment = null;
		if (parentId) {
			let parentRes;
			try {
				parentRes = await fetch(
					`${base}/rest/v1/comments?id=eq.${encodeURIComponent(parentId)}&lesson_id=eq.${encodeURIComponent(lessonId)}&select=id,author_id&limit=1`,
					{ headers: supabaseHeaders(env) },
				);
			} catch (e) {
				return textResponse('Could not reach the comment store.', 502, cors);
			}
			const parentRows = parentRes.ok ? await parentRes.json().catch(() => []) : [];
			if (!Array.isArray(parentRows) || parentRows.length === 0) {
				return textResponse('The comment you’re replying to no longer exists.', 404, cors);
			}
			parentComment = parentRows[0];
		}

		const insert = {
			lesson_id: lessonId,
			parent_id: parentId || null,
			author_id: user.id,
			author: authorFromUser(user),
			body: text,
		};

		let res;
		try {
			res = await fetch(`${base}/rest/v1/comments?select=id,parent_id,author,body,created_at`, {
				method: 'POST',
				headers: {
					...supabaseHeaders(env),
					'Content-Type': 'application/json',
					Prefer: 'return=representation',
				},
				body: JSON.stringify(insert),
			});
		} catch (e) {
			return textResponse('Could not reach the comment store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not post the comment.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Could not post the comment.', 502, cors);
		}
		const comment = rowToComment(rows[0]);

		// A reply notifies two people: the parent comment's author ("replied to your
		// comment") and the lesson's author ("replied to a comment on your lesson").
		// We dedupe by recipient id with a Map, so when the lesson author is also the
		// parent comment's author they get a single notification (keeping the more
		// specific "your comment" wording), and we never notify the replier themselves.
		// Notification failures are swallowed so they can't fail the reply.
		if (parentComment) {
			const replier = authorFromUser(user);
			const link = `/hub/${encodeURIComponent(lessonId)}`;
			const byRecipient = new Map();
			if (parentComment.author_id && parentComment.author_id !== user.id) {
				byRecipient.set(parentComment.author_id, `${replier} replied to your comment`);
			}
			if (lesson.author_id && lesson.author_id !== user.id && !byRecipient.has(lesson.author_id)) {
				byRecipient.set(lesson.author_id, `${replier} replied to a comment on your lesson`);
			}
			await Promise.all(
				[...byRecipient.entries()].map(([userId, title]) =>
					createNotification(env, base, { userId, type: 'comment', title, body: text, link }).catch(() => {}),
				),
			);
		}

		return jsonResponse({ comment }, 201, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}

/**
 * "Thumbs down" a cached AI text suggestion: evict it from KV so the next
 * request for the same subject regenerates a fresh answer instead of serving
 * the disliked one. Only text suggestions are cached (see the text-mode cache
 * note in `fetch`), so this is the only thing there is to remove.
 *
 *   POST /ai-text/dislike   Bearer <Supabase JWT>   -> { ok: true }
 *
 * Requires a signed-in user — the action is gated by a verified Supabase JWT
 * (like the lesson-hub writes), not Turnstile, so it never consumes a token or
 * touches the AI rate limiter. The body carries exactly the inputs that shape
 * the cached text, so we can rebuild the identical key `cacheKey` wrote.
 */
async function handleTextFeedback(request, env, cors) {
	if (request.method !== 'POST') return textResponse('Method not allowed.', 405, cors);
	if (!env || !env.RATE_LIMIT_KV) {
		return textResponse('Server misconfiguration: RATE_LIMIT_KV not bound', 500, cors);
	}
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}

	// Gate on a verified Supabase session — sign-in is required.
	const auth = request.headers.get('Authorization') || '';
	const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
	const user = await verifySupabaseUser(env, token);
	if (!user) return textResponse('Please sign in to give feedback.', 401, cors);

	let body;
	try {
		body = await request.json();
	} catch (e) {
		return textResponse('Invalid JSON body', 400, cors);
	}
	const subject = (body && body.subject ? String(body.subject) : '').trim();
	if (!subject) return textResponse('Missing "subject" in request body', 400, cors);
	const documentName = body && body.documentName ? String(body.documentName) : '';

	// Rebuild the exact key the text suggester writes (see the text-mode cache
	// put in `fetch`) and drop it. Deleting a missing key is a no-op, so a stale
	// or already-expired entry still reports success.
	const cKey = await cacheKey(['text', subject, documentName]);
	await env.RATE_LIMIT_KV.delete(cKey);

	return jsonResponse({ ok: true }, 200, cors);
}

// The longest "send link" message we accept.
const MAX_NOTIFICATION_MESSAGE_LENGTH = 1000;

// A minimal email shape check for the "send link" recipient. Real delivery is to
// whoever signs in with this email, so this only guards obviously-invalid input.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Map a Supabase `notifications` row to the camelCase shape the frontend expects.
 */
function rowToNotification(row) {
	return {
		id: row.id,
		type: row.type,
		title: row.title,
		body: row.body,
		link: row.link,
		read: row.read,
		createdAt: row.created_at,
	};
}

/**
 * Insert a notification row via the service-role REST API and return the fetch
 * Response (with the created row when Prefer: return=representation succeeds).
 * `recipient` is { userId?, email? }: at least one identifies who receives it —
 * `userId` when we know the auth id (e.g. a lesson's author), `email` when we
 * only have an address (e.g. a link sent to someone who may not have signed in
 * yet). Callers that create notifications as a side effect wrap this in try/catch
 * so a notification failure never fails the primary action.
 */
async function createNotification(env, base, { userId, email, type, title, body, link }) {
	const insert = {
		user_id: userId || null,
		recipient_email: email ? email.trim().toLowerCase() : null,
		type,
		title,
		body: body || null,
		link: link || null,
	};
	return fetch(`${base}/rest/v1/notifications?select=id,type,title,body,link,read,created_at`, {
		method: 'POST',
		headers: {
			...supabaseHeaders(env),
			'Content-Type': 'application/json',
			Prefer: 'return=representation',
		},
		body: JSON.stringify(insert),
	});
}

/**
 * Notification endpoints, backed by Supabase Postgres. Every route requires a
 * verified Supabase session. A user sees notifications addressed to their auth id
 * OR to their email — the email match lets a "send link" reach someone before we
 * know their id. Writes go through the service-role key like the rest of the API.
 *
 *   GET  /notifications            Bearer -> { notifications: Notification[] }   (newest first)
 *   POST /notifications/read       Bearer -> { ok: true }            (body { id? }: one, or all)
 *   POST /notifications/send-link  Bearer -> { notification }        (body { email, link, message? })
 *
 * Errors are short plain-text reasons so the frontend can surface res.text().
 */
async function handleNotifications(request, env, url, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}

	const auth = request.headers.get('Authorization') || '';
	const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
	const user = await verifySupabaseUser(env, token);
	if (!user) return textResponse('Please sign in to view notifications.', 401, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');
	const email = (user.email || '').trim().toLowerCase();
	// A notification reaches the user if it targets their id or their email.
	const audience = `or=(user_id.eq.${user.id},recipient_email.eq.${email})`;
	const path = url.pathname.replace(/\/$/, '');

	// GET /notifications — the signed-in user's notifications, newest first.
	if (request.method === 'GET' && path === '/notifications') {
		let res;
		try {
			res = await fetch(
				`${base}/rest/v1/notifications?${audience}&select=id,type,title,body,link,read,created_at&order=created_at.desc&limit=100`,
				{ headers: supabaseHeaders(env) },
			);
		} catch (e) {
			return textResponse('Could not reach the notification store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load notifications.', 502, cors);
		const rows = await res.json().catch(() => []);
		const notifications = (Array.isArray(rows) ? rows : []).map(rowToNotification);
		return jsonResponse({ notifications }, 200, cors);
	}

	// POST /notifications/read — mark one (body.id) or all of the user's unread
	// notifications as read. The audience filter scopes the update to the caller's
	// own notifications, so an id they don't own matches nothing.
	if (request.method === 'POST' && path === '/notifications/read') {
		let body;
		try {
			body = await request.json();
		} catch (e) {
			body = {};
		}
		const id = body && body.id ? String(body.id) : '';
		const idFilter = id ? `&id=eq.${encodeURIComponent(id)}` : '';
		let res;
		try {
			res = await fetch(`${base}/rest/v1/notifications?${audience}${idFilter}&read=eq.false`, {
				method: 'PATCH',
				headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json' },
				body: JSON.stringify({ read: true }),
			});
		} catch (e) {
			return textResponse('Could not reach the notification store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not update notifications.', 502, cors);
		return jsonResponse({ ok: true }, 200, cors);
	}

	// POST /notifications/send-link — send a link to a user identified by email.
	// It appears in that user's notifications the next time they load them. The
	// sender is taken from the verified session, never from the request body.
	if (request.method === 'POST' && path === '/notifications/send-link') {
		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const recipient = (body && body.email ? String(body.email) : '').trim().toLowerCase();
		const link = (body && body.link ? String(body.link) : '').trim();
		const message = (body && body.message ? String(body.message) : '').trim();

		if (!EMAIL_RE.test(recipient)) {
			return textResponse('Enter a valid email address.', 400, cors);
		}
		if (!link) return textResponse('Enter a link to send.', 400, cors);
		let linkUrl;
		try {
			linkUrl = new URL(link);
		} catch (e) {
			return textResponse('Enter a valid link (including http:// or https://).', 400, cors);
		}
		if (linkUrl.protocol !== 'http:' && linkUrl.protocol !== 'https:') {
			return textResponse('Links must start with http:// or https://.', 400, cors);
		}
		if (message.length > MAX_NOTIFICATION_MESSAGE_LENGTH) {
			return textResponse(`Messages are limited to ${MAX_NOTIFICATION_MESSAGE_LENGTH} characters.`, 400, cors);
		}
		// Moderate the optional message like comments — done server-side so it
		// can't be bypassed by a crafted client request.
		if (message && profanityFilter.checkProfanity(message).containsProfanity) {
			return textResponse('This message contains language that isn’t allowed. Please revise it and try again.', 422, cors);
		}

		let res;
		try {
			res = await createNotification(env, base, {
				email: recipient,
				type: 'link',
				title: `${authorFromUser(user)} sent you a link`,
				body: message || null,
				link: linkUrl.toString(),
			});
		} catch (e) {
			return textResponse('Could not reach the notification store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not send the link.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Could not send the link.', 502, cors);
		}
		return jsonResponse({ notification: rowToNotification(rows[0]) }, 201, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}

// ---------------------------------------------------------------------------
// Crawler prerendering
//
// The Worker serves the React SPA (env.ASSETS). Search engines and social
// scrapers that don't run JavaScript would otherwise only see the empty
// index.html shell, so we detect them by User-Agent and instead return a fully
// rendered HTML snapshot produced by headless Chromium (@cloudflare/puppeteer).
// ---------------------------------------------------------------------------

// User-Agents of crawlers/scrapers worth prerendering for: search engines and
// the link-preview bots used by social/chat platforms.
const CRAWLER_UA =
	/googlebot|bingbot|slurp|duckduckbot|baiduspider|yandex|sogou|exabot|facebookexternalhit|facebot|twitterbot|linkedinbot|embedly|quora link preview|pinterest|slackbot|slack-imgproxy|vkshare|w3c_validator|whatsapp|telegrambot|discordbot|redditbot|applebot|petalbot|bytespider|ia_archiver|skypeuripreview|google-inspectiontool/i;

// Query flag the prerender browser appends when it loads the page, so the
// Worker serves the real SPA shell instead of recursively prerendering itself.
const PRERENDER_BYPASS = '__prerender';

function isCrawler(request) {
	const ua = request.headers.get('user-agent') || '';
	return CRAWLER_UA.test(ua);
}

// True for requests we should consider prerendering: a crawler GET for an HTML
// document (not a hashed asset like /assets/app.js or an image).
function shouldPrerender(request, url) {
	if (request.method !== 'GET') return false;
	if (url.searchParams.has(PRERENDER_BYPASS)) return false;
	if (!isCrawler(request)) return false;
	const accept = request.headers.get('accept') || '';
	const isDoc = accept.includes('text/html') || !/\.[a-z0-9]+$/i.test(url.pathname);
	return isDoc;
}

// Render the page with headless Chromium and return its serialized HTML. Results
// are cached (keyed by path) so repeat crawler hits don't each spin up a browser.
async function prerender(request, env, ctx, url) {
	const cache = caches.default;
	// Cache under a synthetic key so a prerendered snapshot is never accidentally
	// served to a real user requesting the same path.
	const cacheKey = new Request(`${url.origin}${url.pathname}?${PRERENDER_BYPASS}=cache`, { method: 'GET' });
	const hit = await cache.match(cacheKey);
	if (hit) return hit;

	// The browser loads this same Worker; the bypass flag stops it prerendering
	// itself, so it gets the static SPA shell + assets and renders the page.
	const target = new URL(url);
	target.searchParams.set(PRERENDER_BYPASS, '1');

	let browser;
	try {
		browser = await puppeteer.launch(env.BROWSER);
		const page = await browser.newPage();

		// Skip resources that don't affect the rendered markup we capture: images,
		// fonts, media, and the third-party widgets (Turnstile, Google Identity)
		// that only matter for live interaction. This keeps the render fast and
		// lets the page reach network-idle promptly.
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const type = req.resourceType();
			if (type === 'image' || type === 'media' || type === 'font') return req.abort();
			if (/challenges\.cloudflare\.com|accounts\.google\.com|fonts\.g(oogleapis|static)\.com/.test(req.url())) {
				return req.abort();
			}
			req.continue();
		});

		await page.goto(target.toString(), { waitUntil: 'networkidle0', timeout: 20000 });
		const html = await page.content();

		const response = new Response(html, {
			status: 200,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				// Let the edge serve repeat crawler hits without re-rendering.
				'Cache-Control': 'public, max-age=3600',
				'X-Prerendered': '1',
			},
		});
		ctx.waitUntil(cache.put(cacheKey, response.clone()));
		return response;
	} catch (err) {
		// If rendering fails (timeout, quota, etc.) fall back to the SPA shell so
		// the crawler still receives valid HTML rather than an error.
		return env.ASSETS.fetch(request);
	} finally {
		if (browser) await browser.close();
	}
}

// Standard Open Graph / Twitter preview image dimensions (1.91:1).
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// GET /og-image?path=/hub/:id — render the given in-site path with the same
// headless Chromium used for prerendering and return a PNG screenshot sized for
// social link previews. The per-page <meta property="og:image"> the SPA writes
// (see web/src/lib/seo.js) points here, so the preview a scraper fetches is a
// live snapshot of the actual page. Results are edge-cached by path so repeat
// hits don't each spin up a browser.
async function ogImage(request, env, ctx, url) {
	if (!env.BROWSER) return textResponse('Browser rendering unavailable.', 503);

	// Only ever screenshot a same-site path. Strip any query/hash so the cache
	// key (and the rendered preview) stays stable per page.
	let path = url.searchParams.get('path') || '/';
	if (!path.startsWith('/') || path.startsWith('//')) path = '/';
	path = path.split(/[?#]/)[0];

	const cache = caches.default;
	const cacheKey = new Request(`${url.origin}/og-image?path=${encodeURIComponent(path)}`, { method: 'GET' });
	const hit = await cache.match(cacheKey);
	if (hit) return hit;

	// Load this same Worker with the bypass flag so it serves the real SPA shell
	// + assets (rather than recursively prerendering) and renders the page.
	const target = new URL(`${url.origin}${path}`);
	target.searchParams.set(PRERENDER_BYPASS, '1');

	let browser;
	try {
		browser = await puppeteer.launch(env.BROWSER);
		const page = await browser.newPage();
		await page.setViewport({ width: OG_WIDTH, height: OG_HEIGHT, deviceScaleFactor: 1 });

		// Unlike prerendering we keep images and fonts — they're exactly what the
		// screenshot is meant to capture — and only block the interactive
		// third-party widgets (Turnstile, Google Identity) so the page can still
		// reach network-idle promptly.
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			if (/challenges\.cloudflare\.com|accounts\.google\.com/.test(req.url())) {
				return req.abort();
			}
			req.continue();
		});

		await page.goto(target.toString(), { waitUntil: 'networkidle0', timeout: 20000 });
		const buffer = await page.screenshot({
			type: 'png',
			clip: { x: 0, y: 0, width: OG_WIDTH, height: OG_HEIGHT },
		});

		const response = new Response(buffer, {
			status: 200,
			headers: {
				'Content-Type': 'image/png',
				// Let the edge serve repeat scraper hits without re-rendering.
				'Cache-Control': 'public, max-age=3600',
				'X-Og-Image': '1',
			},
		});
		ctx.waitUntil(cache.put(cacheKey, response.clone()));
		return response;
	} catch (err) {
		return textResponse('Failed to render preview image.', 500);
	} finally {
		if (browser) await browser.close();
	}
}

/** XML-escape a value for safe inclusion in a <loc> element. */
function xmlEscape(value) {
	return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * GET /sitemap.xml — a dynamically generated sitemap covering the static pages
 * (root and /hub) plus one URL per published lesson (/hub/:id). The lesson list
 * comes from the same Supabase query as the public hub listing, so unpublished
 * drafts never leak into the sitemap. Lesson `created_at` becomes <lastmod>.
 *
 * URLs are built from the request's own origin so the sitemap is correct on any
 * host (custom domain or workers.dev). If Supabase is unreachable we still serve
 * the static entries rather than failing the whole sitemap.
 */
async function handleSitemap(request, env, url) {
	const origin = url.origin;
	const urls = [
		{ loc: `${origin}/`, changefreq: 'weekly', priority: '1.0' },
		{ loc: `${origin}/hub`, changefreq: 'daily', priority: '0.8' },
	];

	if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
		const base = env.SUPABASE_URL.replace(/\/$/, '');
		const query = 'published=eq.true&select=id,created_at&order=created_at.desc';
		try {
			const res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
			if (res.ok) {
				const rows = await res.json().catch(() => []);
				for (const row of Array.isArray(rows) ? rows : []) {
					if (!row || !row.id) continue;
					const entry = { loc: `${origin}/hub/${encodeURIComponent(row.id)}`, changefreq: 'weekly', priority: '0.6' };
					if (row.created_at) entry.lastmod = new Date(row.created_at).toISOString().slice(0, 10);
					urls.push(entry);
				}
			}
		} catch (e) {
			// Supabase unreachable: fall back to the static entries already queued.
		}
	}

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
	.map((u) => {
		const lines = [`\t\t<loc>${xmlEscape(u.loc)}</loc>`];
		if (u.lastmod) lines.push(`\t\t<lastmod>${u.lastmod}</lastmod>`);
		if (u.changefreq) lines.push(`\t\t<changefreq>${u.changefreq}</changefreq>`);
		if (u.priority) lines.push(`\t\t<priority>${u.priority}</priority>`);
		return `\t<url>\n${lines.join('\n')}\n\t</url>`;
	})
	.join('\n')}
</urlset>`;

	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Cache-Control': 'public, max-age=3600',
		},
	});
}

/**
 * GET /robots.txt — allow all crawlers and advertise the dynamic sitemap. The
 * Sitemap URL is built from the request's own origin so it stays correct on any
 * host (custom domain or workers.dev).
 */
function handleRobots(request, env, url) {
	const body = `User-agent: *\nAllow: /\n\nSitemap: ${url.origin}/sitemap.xml\n`;
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=86400',
		},
	});
}

// Serve the frontend: prerender for crawlers, otherwise hand back the static
// asset (env.ASSETS resolves SPA routes to index.html via not_found_handling).
async function handleFrontend(request, env, ctx, url) {
	if (env.BROWSER && shouldPrerender(request, url)) {
		return prerender(request, env, ctx, url);
	}
	return env.ASSETS.fetch(request);
}

export default {
	async fetch(request, env, ctx) {
		const LIMIT = 60;
		const WINDOW = 60;
		const ip = request.headers.get('cf-connecting-ip') || 'unknown';
		const rlKey = `rl:${ip}`;

		const allowedHostnames = (env.ALLOWED_HOSTNAMES || '')
			.split(',')
			.map((h) => h.trim())
			.filter(Boolean);
		const cors = corsHeaders(request, allowedHostnames);

		// Respond to the CORS preflight before any body parsing or rate limiting.
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: cors });
		}

		// Lesson-hub routes are handled separately: they talk to Supabase Postgres,
		// gate writes with a Supabase JWT (not Turnstile), and allow public GETs.
		// Everything else falls through to the Turnstile-gated AI / image flow.
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/$/, '');

		// Lesson images stored in R2, addressed by content hash. GET/HEAD is public
		// (published lessons and the og-image/prerender browser load them); PUT is
		// authenticated and verifies the body against the hash. Handled before the
		// frontend fall-through so the SPA catch-all never shadows it.
		const imageMatch = path.match(/^\/images\/([^/]+)$/);
		if (imageMatch) {
			const hash = imageMatch[1];
			if (request.method === 'GET' || request.method === 'HEAD') {
				return handleImageGet(request, env, ctx, hash);
			}
			if (request.method === 'PUT') {
				return handleImagePut(request, env, hash, cors);
			}
			return textResponse('Method not allowed.', 405, cors);
		}

		if (path === '/lessons' || path.startsWith('/lessons/')) {
			// /lessons/:id/comments is its own (also Supabase-backed) handler;
			// everything else under /lessons is the lesson collection/item.
			const commentsMatch = path.match(/^\/lessons\/([^/]+)\/comments$/);
			if (commentsMatch) {
				return handleComments(request, env, decodeURIComponent(commentsMatch[1]), cors);
			}
			return handleLessons(request, env, url, cors);
		}

		// Negative feedback on a cached AI text suggestion: a signed-in user can
		// evict the cached answer so the next request regenerates it. Like the
		// lesson-hub writes, this is gated by a Supabase JWT rather than Turnstile,
		// so it is handled before the Turnstile/rate-limit AI flow below.
		if (path === '/ai-text/dislike') {
			return handleTextFeedback(request, env, cors);
		}

		// Notification routes: a user's notifications and the "send link" action.
		// Like the lesson-hub writes, these are gated by a Supabase JWT rather than
		// Turnstile, so they are handled before the Turnstile/rate-limit AI flow.
		if (path === '/notifications' || path.startsWith('/notifications/')) {
			return handleNotifications(request, env, url, cors);
		}

		// One-time admin backfill: convert existing lessons' inline base64 images
		// to R2 objects + hash refs. Secret-gated (X-Admin-Token), POST-only.
		if (path === '/admin/migrate-images') {
			return handleAdminMigrateImages(request, env, cors);
		}

		// Dynamic sitemap: the static pages plus one entry per published lesson
		// (/hub/:id), built from the same Supabase listing the hub uses. Served
		// before the frontend fall-through so the SPA's catch-all never shadows it.
		if (path === '/sitemap.xml') {
			return handleSitemap(request, env, url);
		}

		// robots.txt: allow everything and point crawlers at the dynamic sitemap.
		if (path === '/robots.txt') {
			return handleRobots(request, env, url);
		}

		// Open Graph preview image: a headless-Chromium screenshot of an in-site
		// page, referenced by the per-page og:image meta tag. Served before the
		// frontend fall-through so the SPA's catch-all never shadows it.
		if (path === '/og-image') {
			return ogImage(request, env, ctx, url);
		}

		// Everything else that is a GET/HEAD is a request for the frontend: serve
		// the SPA's static assets, or a prerendered snapshot for crawlers. The
		// Turnstile-gated AI flow below is POST-only, so this never shadows it.
		if (request.method === 'GET' || request.method === 'HEAD') {
			return handleFrontend(request, env, ctx, url);
		}

		// KV guard
		if (!env || !env.RATE_LIMIT_KV) {
			return new Response('Server misconfiguration: RATE_LIMIT_KV not bound', { status: 500, headers: cors });
		}

		// Read the request JSON. `mode` selects the suggester: "text" (default)
		// generates a block of lesson text; "question" generates a structured
		// quiz question of the requested `questionType`.
		let body;
		try {
			body = await request.json();
		} catch {
			return new Response('Invalid JSON body', { status: 400, headers: cors });
		}
		const mode = KNOWN_MODES.has(body.mode) ? body.mode : 'text';
		const subject = body.subject || '';
		const token = body.token || '';
		const documentName = body.documentName || '';
		const questionType = body.questionType || 'single';
		const sectionText = body.sectionText || '';
		// Age range the lesson is pitched at (e.g. "7–9 years"); used by the
		// lessonIdea suggester to tailor topic ideas. Capped so it can't bloat the
		// prompt.
		const ageRange = typeof body.ageRange === 'string' ? body.ageRange.trim().slice(0, 60) : '';
		// Prompts of questions already in the section, so we can ask the model
		// not to repeat them. Keep only non-empty strings and cap the count so a
		// large section can't blow up the prompt.
		const existingQuestions = Array.isArray(body.existingQuestions)
			? body.existingQuestions.filter((q) => typeof q === 'string' && q.trim()).slice(0, 50)
			: [];
		// Image-search fields (imageSearch / imageFetch modes).
		const query = body.query || '';
		const imageUrl = body.url || '';
		const page = body.page || 1;
		const perPage = body.perPage || 20;
		// The AI suggesters need a subject; the image modes carry their own
		// fields instead and are validated inside their handlers.
		if ((mode === 'text' || mode === 'question') && !subject) {
			return new Response('Missing "subject" in request body', { status: 400, headers: cors });
		}
		if (mode === 'question' && !QUESTION_SCHEMAS[questionType]) {
			return new Response('Unknown "questionType" in request body', { status: 400, headers: cors });
		}

		// Validate the request really came from our domain via Turnstile.
		// This relies on the verified `hostname` from Cloudflare's siteverify
		// response, not on spoofable Origin/Referer headers.
		const turnstile = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, allowedHostnames, ip);
		if (!turnstile.ok) {
			return new Response(turnstile.reason, { status: turnstile.status, headers: cors });
		}

		// Token-bucket rate limiter: read the current bucket and refill it for the
		// elapsed time, but defer the decrement until after the cache check so a
		// cache hit costs nothing against the limit.
		const now = Math.floor(Date.now() / 1000);
		const entryRaw = await env.RATE_LIMIT_KV.get(rlKey);
		let entry = entryRaw ? JSON.parse(entryRaw) : { tokens: LIMIT, last: now };
		const elapsed = now - entry.last;
		const refill = (elapsed * LIMIT) / WINDOW;
		entry.tokens = Math.min(LIMIT, entry.tokens + refill);
		entry.last = now;

		// Successful AI responses all carry the same headers (CORS + rate-limit
		// budget); build them once here.
		const okHeaders = () => {
			const headers = new Headers(cors);
			headers.set('Content-Type', 'application/json');
			headers.set('X-RateLimit-Limit', String(LIMIT));
			headers.set('X-RateLimit-Remaining', String(Math.floor(entry.tokens)));
			return headers;
		};

		// Serve a previously generated answer when the same information has been
		// asked about before. Only text suggestions are cached — question
		// suggestions are intentionally never cached, since users often generate
		// several questions of the same type for one subject and expect a fresh,
		// different question each time. The key covers exactly the inputs that
		// shape the text, normalized case-insensitively, so repeated requests skip
		// the AI call. A cache hit is served before the rate-limit charge below,
		// so it neither consumes a token nor can be rejected by the limiter.
		const cKey = mode === 'text' ? await cacheKey(['text', subject, documentName]) : null;
		if (cKey) {
			const cached = await env.RATE_LIMIT_KV.get(cKey);
			if (cached) {
				return new Response(cached, { status: 200, headers: okHeaders() });
			}
		}

		// Cache miss: charge the rate limit before doing the (billable) AI call.
		if (entry.tokens < 1) {
			const retryAfter = Math.ceil((1 - entry.tokens) * (WINDOW / LIMIT));
			const headers = new Headers(cors);
			headers.set('Content-Type', 'text/plain');
			headers.set('Retry-After', String(retryAfter));
			return new Response('Too Many Requests', { status: 429, headers });
		}
		entry.tokens -= 1;
		await env.RATE_LIMIT_KV.put(rlKey, JSON.stringify(entry), { expirationTtl: WINDOW * 2 });

		// Pixabay image search/fetch. The Worker holds the API key and proxies
		// the request (Pixabay's CDN sends no CORS headers, so the browser can't
		// read the bytes itself). Both modes share the Turnstile check and rate
		// limiter above; the Pixabay response itself is edge-cached for 24h.
		if (mode === 'imageSearch') {
			return handleImageSearch(query, page, perPage, env, okHeaders, cors);
		}
		if (mode === 'imageFetch') {
			return handleImageFetch(imageUrl, okHeaders, cors);
		}

		// Lesson-idea suggester: propose a handful of lesson topics suited to the
		// given age range. Not cached — like questions, users expect a fresh batch
		// of ideas each time they ask.
		if (mode === 'lessonIdea') {
			const audienceBlock = ageRange
				? ` for students aged ${ageRange}. Pitch the topics, language, and complexity so they are appropriate and engaging for that age group.`
				: ' for school students.';
			const prompt = `Suggest 6 varied, engaging lesson topic ideas${audienceBlock} Each lesson will become a spelling/vocabulary lesson, so favour topics rich in interesting words. For each idea, give a short, catchy "title" suitable to use directly as the lesson title, and a one-sentence "description" of what the lesson would cover. Make the ideas span a range of subjects (science, history, nature, everyday life, etc.) rather than clustering around one theme.`;

			try {
				const aiResponse = await generateContentWithFallback({
					contents: prompt,
					config: {
						responseMimeType: 'application/json',
						responseSchema: LESSON_IDEA_SCHEMA,
					},
				});

				const parsed = JSON.parse(aiResponse.text);
				const ideas = Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, 12) : [];
				return new Response(JSON.stringify({ ideas }), { status: 200, headers: okHeaders() });
			} catch (err) {
				return new Response('Upstream AI error', { status: 502, headers: cors });
			}
		}

		// Include the overall lesson title (when we have one) so the model can
		// pitch the content to fit the wider document.
		const contextBlock = documentName ? `\n\nThis text is part of a lesson titled "${documentName}".` : '';

		if (mode === 'question') {
			// Ground the question in the section's existing text when we have it, so
			// the suggested question is actually answerable from the lesson. For
			// background-knowledge questions the text is the opposite — it marks
			// what the student should already know, so the question must avoid it.
			const sourceBlock = sectionText
				? questionType === 'background'
					? `\n\nThe following is the lesson text. Do NOT base the question on it — the question must test prior knowledge the student needs but that this text does not explain:\n"""\n${sectionText}\n"""`
					: `\n\nBase the question on the following lesson text. DO NOT say "according to the text, ...", as that is already displayed in the UI. :\n"""\n${sectionText}\n"""`
				: '';
			// List the questions already in the section so the model asks something
			// new instead of repeating one the user already has.
			const previousBlock = existingQuestions.length
				? `\n\nThe lesson already includes the following questions. Ask about something different — do not repeat or closely paraphrase any of them:\n${existingQuestions
						.map((q) => `- ${q}`)
						.join('\n')}`
				: '';
			const prompt = `Suggest one ${QUESTION_LABELS[questionType]} quiz question for a school lesson about the subject "${subject}".${contextBlock}${sourceBlock}${previousBlock}\n\n${QUESTION_INSTRUCTIONS[questionType]}`;

			try {
				const aiResponse = await generateContentWithFallback({
					contents: prompt,
					config: {
						responseMimeType: 'application/json',
						responseSchema: QUESTION_SCHEMAS[questionType],
					},
				});

				const question = JSON.parse(aiResponse.text);
				question.questionType = questionType;

				// Question suggestions are not cached (see the cache note above).
				return new Response(JSON.stringify({ question }), { status: 200, headers: okHeaders() });
			} catch (err) {
				return new Response('Upstream AI error', { status: 502, headers: cors });
			}
		}

		// Text mode: suggest a block of text about the subject. When we know the
		// document title, the soft `contextBlock` aside above is too easy for the
		// model to ignore — it tends to write a standalone summary of the subject
		// and never mention the document. Replace it here with a hard instruction
		// that forces the model to ground the text in, and explicitly reference,
		// the document title so the block reads as part of that specific lesson.
		const documentBlock = documentName
			? `\n\nThis text is a section of a lesson titled "${documentName}". You MUST treat "${documentName}" as the overarching topic: write the section as part of that lesson, keep it consistent with and relevant to "${documentName}", and explicitly reference the lesson's subject in the text. Do not write a generic, standalone summary of "${subject}" that ignores the lesson title.`
			: '';
		const prompt = `Suggest a block of text about the following subject: "${subject}".${documentBlock}\n\nWrite any unusual or important words, BUT NOT THE LESSON TITLE — THAT IS UNACCEPTABLE, including proper nouns, in ALL CAPITALS so they stand out as spelling words. You may also include numbers to be used as number answers.\n\nRespond with only the block of text, no preamble or explanation.`;

		try {
			const aiResponse = await generateContentWithFallback({
				contents: prompt,
			});

			const text = aiResponse.text;

			const payload = JSON.stringify({ text });
			await env.RATE_LIMIT_KV.put(cKey, payload, { expirationTtl: CACHE_TTL });
			return new Response(payload, { status: 200, headers: okHeaders() });
		} catch (err) {
			return new Response('Upstream AI error', { status: 502, headers: cors });
		}
	},
};
