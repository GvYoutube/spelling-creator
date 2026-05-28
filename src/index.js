import { GoogleGenAI } from '@google/genai';

let ai; // lazy init

export default {
	async fetch(request, env) {
		// Bind checks
		if (!env || !env.RATE_LIMIT_KV) {
			return new Response('Server misconfiguration: RATE_LIMIT_KV not bound', { status: 500 });
		}
		if (!env.GEMINI_API_KEY) {
			return new Response('Missing GEMINI_API_KEY secret', { status: 500 });
		}

		// lazy-init AI client with env secret
		if (!ai) ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

		const LIMIT = 60;
		const WINDOW = 60;
		const ip = request.headers.get('cf-connecting-ip') || 'unknown';
		const key = `rl:${ip}`;

		// Rate limit token-bucket
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

		// Parse subject
		let subject = '';
		try {
			const body = await request.json();
			subject = body.subject || '';
		} catch (e) {
			return new Response('Invalid JSON body', { status: 400 });
		}
		if (!subject) return new Response('Missing "subject" in request body', { status: 400 });

		const prompt = `Suggest a block of text about the following subject: "${subject}". Respond with only the block of text, no preamble or explanation.`;

		try {
			const aiResponse = await ai.models.generateContent({
				model: 'gemini-2.5-flash',
				contents: [{ type: 'text', text: prompt }],
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
