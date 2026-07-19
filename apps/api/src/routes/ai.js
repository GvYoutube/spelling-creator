// The Turnstile-gated AI / image flow — the Worker's POST entrypoint (`POST /`).
// `mode` selects the suggester: "text"/"question"/"lessonIdea" drive Gemini;
// "imageSearch"/"imageFetch" proxy Pixabay. All share the Turnstile check and the
// per-IP token-bucket rate limiter below; text suggestions are additionally cached.

import { generateWithFallback, QUESTION_SCHEMAS, QUESTION_LABELS, QUESTION_INSTRUCTIONS, LESSON_IDEA_SCHEMA } from '../lib/ai/index.js';
import { cacheKey } from '../lib/cache.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { textResponse } from '../lib/http.js';

// How long a cached AI answer lives in KV.
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

// The request modes this Worker understands. "text"/"question" drive the AI
// suggesters; "imageSearch"/"imageFetch" drive the Pixabay image search. Any
// unknown mode falls back to "text".
const KNOWN_MODES = new Set(['text', 'question', 'imageSearch', 'imageFetch', 'lessonIdea']);

// The only hosts the image proxy will ever fetch from — an SSRF guard so a
// crafted `url` can't make the Worker fetch arbitrary internal/external targets.
const PIXABAY_HOSTS = new Set(['pixabay.com', 'cdn.pixabay.com']);

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
 * The Turnstile-gated AI / image entrypoint (POST /). Reads the request JSON,
 * verifies Turnstile, charges the per-IP rate limiter (a cached text answer is
 * served first and costs nothing), then dispatches on `mode`.
 */
export async function handleAi(request, env, cors, allowedHostnames) {
	const LIMIT = 60;
	const WINDOW = 60;
	const ip = request.headers.get('cf-connecting-ip') || 'unknown';
	const rlKey = `rl:${ip}`;

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
			const aiResponse = await generateWithFallback({ prompt, schema: LESSON_IDEA_SCHEMA, env });

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
			const aiResponse = await generateWithFallback({ prompt, schema: QUESTION_SCHEMAS[questionType], env });

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
		const aiResponse = await generateWithFallback({ prompt, env });

		const text = aiResponse.text;

		const payload = JSON.stringify({ text });
		await env.RATE_LIMIT_KV.put(cKey, payload, { expirationTtl: CACHE_TTL });
		return new Response(payload, { status: 200, headers: okHeaders() });
	} catch (err) {
		return new Response('Upstream AI error', { status: 502, headers: cors });
	}
}
