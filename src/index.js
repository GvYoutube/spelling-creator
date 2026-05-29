import { env } from 'cloudflare:workers';
import { GoogleGenAI, Type } from '@google/genai';
import { Filter } from 'glin-profanity';

const GEMINI_API_KEY = env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Shared profanity filter for moderating lesson comments. Built once (it compiles
// its word list into a regex) and reused across requests. `checkProfanity(text)`
// returns { containsProfanity, profaneWords }; we reject a comment outright when
// containsProfanity is true rather than censoring individual words.
const profanityFilter = new Filter();

const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Structured-output schemas for the question suggester, one per question type.
// They mirror the block shapes the editor builds in src/lib/questions.js: the
// frontend turns option indexes back into option ids when inserting the block.
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
			options: { type: Type.ARRAY, items: { type: Type.STRING } },
			correctIndex: { type: Type.INTEGER },
		},
		required: ['prompt', 'options', 'correctIndex'],
	},
	multiple: {
		type: Type.OBJECT,
		properties: {
			prompt: { type: Type.STRING },
			options: { type: Type.ARRAY, items: { type: Type.STRING } },
			correctIndexes: { type: Type.ARRAY, items: { type: Type.INTEGER } },
		},
		required: ['prompt', 'options', 'correctIndexes'],
	},
	open: {
		type: Type.OBJECT,
		properties: { prompt: { type: Type.STRING } },
		required: ['prompt'],
	},
	background: {
		type: Type.OBJECT,
		properties: { prompt: { type: Type.STRING }, background: { type: Type.STRING } },
		required: ['prompt', 'background'],
	},
};

// How to describe each question type in the prompt, and the type-specific rules
// the model must follow so its JSON matches the schema above.
const QUESTION_LABELS = {
	number: 'number-answer',
	single: 'single-choice',
	multiple: 'multiple-choice',
	open: 'open-ended',
	background: 'background-knowledge',
};

const QUESTION_INSTRUCTIONS = {
	number: 'The question must have a single numeric answer. Put that number in the "answer" field.',
	single:
		'Provide 3 or 4 answer options in "options", with exactly one correct. Put the zero-based position of the correct option in "correctIndex".',
	multiple:
		'Provide 4 or 5 answer options in "options", with two or more correct. Put the zero-based positions of every correct option in "correctIndexes".',
	open: 'Write a question that invites a free, written response. Do not provide answer options.',
	background: 'Put the question in "prompt", and a short paragraph of the prior knowledge a student needs to answer it in "background".',
};

// How long a cached AI answer lives in KV.
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

// The request modes this Worker understands. "text"/"question" drive the AI
// suggesters; "imageSearch"/"imageFetch" drive the Pixabay image search. Any
// unknown mode falls back to "text".
const KNOWN_MODES = new Set(['text', 'question', 'imageSearch', 'imageFetch']);

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
		return { ok: false, status: 403, reason: 'Turnstile verification failed' };
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
		let allowed = false;
		try {
			allowed = allowedHostnames.includes(new URL(origin).hostname);
		} catch (e) {
			allowed = false;
		}
		if (allowed) {
			headers.set('Access-Control-Allow-Origin', origin);
			headers.set('Vary', 'Origin');
			headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
		title: row.title,
		author: row.author,
		sectionCount: row.section_count ?? 0,
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
 *   GET  /lessons        public  -> { lessons: LessonSummary[] }   (newest first)
 *   GET  /lessons/:id    public  -> { lesson: Lesson }             (includes doc)
 *   POST /lessons        Bearer  -> { lesson: LessonSummary }      (verified JWT)
 *
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

	// GET /lessons/:id — one published lesson, including its full editor doc.
	if (request.method === 'GET' && id) {
		const query = `id=eq.${encodeURIComponent(id)}&select=id,title,author,section_count,created_at,doc&limit=1`;
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

	// GET /lessons — public listing, newest first. The doc (which can be large,
	// holding base64 image data) is deliberately excluded; section_count gives the
	// summary its count without shipping every block.
	if (request.method === 'GET') {
		const query = 'select=id,title,author,section_count,created_at&order=created_at.desc';
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

	// POST /lessons — publish. Requires a valid Supabase session JWT; the author
	// is derived from the verified user, never from the request body.
	if (request.method === 'POST' && !id) {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in before publishing.', 401, cors);

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const doc = body && body.doc;
		if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sections) || doc.sections.length === 0) {
			return textResponse('Add at least one section before publishing.', 400, cors);
		}
		const title = (body.title || doc.title || 'Untitled Lesson').toString().slice(0, 300);

		const insert = {
			author_id: user.id,
			author: authorFromUser(user),
			title,
			doc,
		};

		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?select=id,title,author,section_count,created_at`, {
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
		if (!res.ok) return textResponse('Could not publish the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Could not publish the lesson.', 502, cors);
		}
		return jsonResponse({ lesson: rowToLesson(rows[0], false) }, 201, cors);
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
		const query = `lesson_id=eq.${encodeURIComponent(lessonId)}&select=id,author,body,created_at&order=created_at.asc`;
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

		// Moderation: block the entire comment if it contains profanity. Done
		// server-side so it can't be bypassed by a crafted client request.
		if (profanityFilter.checkProfanity(text).containsProfanity) {
			return textResponse('This comment contains language that isn’t allowed. Please revise it and try again.', 422, cors);
		}

		// The lesson must exist; the FK would reject an orphan comment anyway, but
		// checking first lets us return a clear 404 instead of a generic store error.
		let lessonRes;
		try {
			lessonRes = await fetch(`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(lessonId)}&select=id&limit=1`, {
				headers: supabaseHeaders(env),
			});
		} catch (e) {
			return textResponse('Could not reach the comment store.', 502, cors);
		}
		const lessonRows = lessonRes.ok ? await lessonRes.json().catch(() => []) : [];
		if (!Array.isArray(lessonRows) || lessonRows.length === 0) {
			return textResponse('Lesson not found.', 404, cors);
		}

		const insert = {
			lesson_id: lessonId,
			author_id: user.id,
			author: authorFromUser(user),
			body: text,
		};

		let res;
		try {
			res = await fetch(`${base}/rest/v1/comments?select=id,author,body,created_at`, {
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
		return jsonResponse({ comment: rowToComment(rows[0]) }, 201, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}

export default {
	async fetch(request, env) {
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
		if (path === '/lessons' || path.startsWith('/lessons/')) {
			// /lessons/:id/comments is its own (also Supabase-backed) handler;
			// everything else under /lessons is the lesson collection/item.
			const commentsMatch = path.match(/^\/lessons\/([^/]+)\/comments$/);
			if (commentsMatch) {
				return handleComments(request, env, decodeURIComponent(commentsMatch[1]), cors);
			}
			return handleLessons(request, env, url, cors);
		}

		// KV guard
		if (!env || !env.RATE_LIMIT_KV) {
			return new Response('Server misconfiguration: RATE_LIMIT_KV not bound', { status: 500, headers: cors });
		}

		// Read the request JSON. `mode` selects the suggester: "text" (default)
		// generates a block of lesson text; "question" generates a structured
		// quiz question of the requested `questionType`.
		let mode = 'text';
		let subject = '';
		let token = '';
		let documentName = '';
		let questionType = 'single';
		let sectionText = '';
		let existingQuestions = [];
		// Image-search fields (imageSearch / imageFetch modes).
		let query = '';
		let imageUrl = '';
		let page = 1;
		let perPage = 20;
		try {
			const body = await request.json();
			mode = KNOWN_MODES.has(body.mode) ? body.mode : 'text';
			subject = body.subject || '';
			token = body.token || '';
			documentName = body.documentName || '';
			questionType = body.questionType || 'single';
			sectionText = body.sectionText || '';
			// Prompts of questions already in the section, so we can ask the model
			// not to repeat them. Keep only non-empty strings and cap the count so a
			// large section can't blow up the prompt.
			existingQuestions = Array.isArray(body.existingQuestions)
				? body.existingQuestions.filter((q) => typeof q === 'string' && q.trim()).slice(0, 50)
				: [];
			query = body.query || '';
			imageUrl = body.url || '';
			page = body.page || 1;
			perPage = body.perPage || 20;
		} catch (e) {
			return new Response('Invalid JSON body', { status: 400, headers: cors });
		}
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

		// Include the overall lesson title (when we have one) so the model can
		// pitch the content to fit the wider document.
		const contextBlock = documentName ? `\n\nThis text is part of a lesson titled "${documentName}".` : '';

		if (mode === 'question') {
			// Ground the question in the section's existing text when we have it, so
			// the suggested question is actually answerable from the lesson.
			const sourceBlock = sectionText ? `\n\nBase the question on the following lesson text:\n"""\n${sectionText}\n"""` : '';
			// List the questions already in the section so the model asks something
			// new instead of repeating one the user already has.
			const previousBlock = existingQuestions.length
				? `\n\nThe lesson already includes the following questions. Ask about something different — do not repeat or closely paraphrase any of them:\n${existingQuestions
						.map((q) => `- ${q}`)
						.join('\n')}`
				: '';
			const prompt = `Suggest one ${QUESTION_LABELS[questionType]} quiz question for a school lesson about the subject "${subject}".${contextBlock}${sourceBlock}${previousBlock}\n\n${QUESTION_INSTRUCTIONS[questionType]}`;

			try {
				const aiResponse = await ai.models.generateContent({
					model: 'gemini-2.5-flash',
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

		// Text mode: suggest a block of text about the subject.
		const prompt = `Suggest a block of text about the following subject: "${subject}".${contextBlock}\n\nWrite any unusual or important words, including proper nouns, in ALL CAPITALS so they stand out as spelling words.\n\nRespond with only the block of text, no preamble or explanation.`;

		try {
			const aiResponse = await ai.models.generateContent({
				model: 'gemini-2.5-flash',
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
