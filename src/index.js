import { env } from 'cloudflare:workers';
import { GoogleGenAI } from '@google/genai';

const GEMINI_API_KEY = env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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

export default {
	async fetch(request, env) {
		const LIMIT = 60;
		const WINDOW = 60;
		const ip = request.headers.get('cf-connecting-ip') || 'unknown';
		const key = `rl:${ip}`;

		// KV guard
		if (!env || !env.RATE_LIMIT_KV) {
			return new Response('Server misconfiguration: RATE_LIMIT_KV not bound', { status: 500 });
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
			return new Response('Too Many Requests', {
				status: 429,
				headers: { 'Content-Type': 'text/plain', 'Retry-After': String(retryAfter) },
			});
		}

		entry.tokens -= 1;
		await env.RATE_LIMIT_KV.put(key, JSON.stringify(entry), { expirationTtl: WINDOW * 2 });

		// Read subject + Turnstile token from request JSON
		let subject = '';
		let token = '';
		try {
			const body = await request.json();
			subject = body.subject || '';
			token = body.token || '';
		} catch (e) {
			return new Response('Invalid JSON body', { status: 400 });
		}
		if (!subject) return new Response('Missing "subject" in request body', { status: 400 });

		// Validate the request really came from our domain via Turnstile.
		// This relies on the verified `hostname` from Cloudflare's siteverify
		// response, not on spoofable Origin/Referer headers.
		const allowedHostnames = (env.ALLOWED_HOSTNAMES || '')
			.split(',')
			.map((h) => h.trim())
			.filter(Boolean);
		const turnstile = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, allowedHostnames, ip);
		if (!turnstile.ok) {
			return new Response(turnstile.reason, { status: turnstile.status });
		}

		// Build a prompt to suggest a block of text based on the subject
		const prompt = `Suggest a block of text about the following subject: "${subject}". Respond with only the block of text, no preamble or explanation.`;

		// Call Gemini via GoogleGenAI instance
		try {
			const aiResponse = await ai.models.generateContent({
				model: 'gemini-2.5-flash',
				contents: prompt,
			});

			const text = aiResponse.text;

			const headers = new Headers();
			headers.set('Content-Type', 'application/json');
			headers.set('X-RateLimit-Limit', String(LIMIT));
			headers.set('X-RateLimit-Remaining', String(Math.floor(entry.tokens)));

			return new Response(JSON.stringify({ text }), { status: 200, headers });
		} catch (err) {
			return new Response('Upstream AI error', { status: 502 });
		}
	},
};
