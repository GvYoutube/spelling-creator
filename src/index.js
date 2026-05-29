import { env } from 'cloudflare:workers';
import { GoogleGenAI, Type } from '@google/genai';

const GEMINI_API_KEY = env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
	background:
		'Put the question in "prompt", and a short paragraph of the prior knowledge a student needs to answer it in "background".',
};

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
			headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
			headers.set('Access-Control-Allow-Headers', 'Content-Type');
			headers.set('Access-Control-Max-Age', '86400');
		}
	}
	return headers;
}

export default {
	async fetch(request, env) {
		const LIMIT = 60;
		const WINDOW = 60;
		const ip = request.headers.get('cf-connecting-ip') || 'unknown';
		const key = `rl:${ip}`;

		const allowedHostnames = (env.ALLOWED_HOSTNAMES || '')
			.split(',')
			.map((h) => h.trim())
			.filter(Boolean);
		const cors = corsHeaders(request, allowedHostnames);

		// Respond to the CORS preflight before any body parsing or rate limiting.
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: cors });
		}

		// KV guard
		if (!env || !env.RATE_LIMIT_KV) {
			return new Response('Server misconfiguration: RATE_LIMIT_KV not bound', { status: 500, headers: cors });
		}

		const now = Math.floor(Date.now() / 1000);
		const entryRaw = await env.RATE_LIMIT_KV.get(key);
		let entry = entryRaw ? JSON.parse(entryRaw) : { tokens: LIMIT, last: now };
		const elapsed = now - entry.last;
		const refill = (elapsed * LIMIT) / WINDOW;
		entry.tokens = Math.min(LIMIT, entry.tokens + refill);
		entry.last = now;

		if (entry.tokens < 1) {
			const retryAfter = Math.ceil((1 - entry.tokens) * (WINDOW / LIMIT));
			const headers = new Headers(cors);
			headers.set('Content-Type', 'text/plain');
			headers.set('Retry-After', String(retryAfter));
			return new Response('Too Many Requests', { status: 429, headers });
		}

		entry.tokens -= 1;
		await env.RATE_LIMIT_KV.put(key, JSON.stringify(entry), { expirationTtl: WINDOW * 2 });

		// Read the request JSON. `mode` selects the suggester: "text" (default)
		// generates a block of lesson text; "question" generates a structured
		// quiz question of the requested `questionType`.
		let mode = 'text';
		let subject = '';
		let token = '';
		let documentName = '';
		let questionType = 'single';
		let sectionText = '';
		try {
			const body = await request.json();
			mode = body.mode === 'question' ? 'question' : 'text';
			subject = body.subject || '';
			token = body.token || '';
			documentName = body.documentName || '';
			questionType = body.questionType || 'single';
			sectionText = body.sectionText || '';
		} catch (e) {
			return new Response('Invalid JSON body', { status: 400, headers: cors });
		}
		if (!subject) return new Response('Missing "subject" in request body', { status: 400, headers: cors });
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

		// Successful AI responses all carry the same headers (CORS + rate-limit
		// budget); build them once here.
		const okHeaders = () => {
			const headers = new Headers(cors);
			headers.set('Content-Type', 'application/json');
			headers.set('X-RateLimit-Limit', String(LIMIT));
			headers.set('X-RateLimit-Remaining', String(Math.floor(entry.tokens)));
			return headers;
		};

		// Include the overall lesson title (when we have one) so the model can
		// pitch the content to fit the wider document.
		const contextBlock = documentName ? `\n\nThis text is part of a lesson titled "${documentName}".` : '';

		if (mode === 'question') {
			// Ground the question in the section's existing text when we have it, so
			// the suggested question is actually answerable from the lesson.
			const sourceBlock = sectionText ? `\n\nBase the question on the following lesson text:\n"""\n${sectionText}\n"""` : '';
			const prompt = `Suggest one ${QUESTION_LABELS[questionType]} quiz question for a school lesson about the subject "${subject}".${contextBlock}${sourceBlock}\n\n${QUESTION_INSTRUCTIONS[questionType]}\n\nWrite any unusual or important words, including proper nouns, in ALL CAPITALS so they stand out as spelling words.`;

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

			return new Response(JSON.stringify({ text }), { status: 200, headers: okHeaders() });
		} catch (err) {
			return new Response('Upstream AI error', { status: 502, headers: cors });
		}
	},
};
