// Negative feedback on a cached AI text suggestion: a signed-in user can evict
// the cached answer so the next request regenerates it. Gated by a Supabase JWT
// (like the lesson-hub writes), not Turnstile, so it never consumes a token or
// touches the AI rate limiter.

import { verifySupabaseUser } from '../lib/supabase.js';
import { cacheKey } from '../lib/cache.js';
import { textResponse, jsonResponse } from '../lib/http.js';

/**
 * "Thumbs down" a cached AI text suggestion: evict it from KV so the next
 * request for the same subject regenerates a fresh answer instead of serving
 * the disliked one. Only text suggestions are cached (see the text-mode cache
 * note in the AI route), so this is the only thing there is to remove.
 *
 *   POST /ai-text/dislike   Bearer <Supabase JWT>   -> { ok: true }
 *
 * Requires a signed-in user — the action is gated by a verified Supabase JWT
 * (like the lesson-hub writes), not Turnstile, so it never consumes a token or
 * touches the AI rate limiter. The body carries exactly the inputs that shape
 * the cached text, so we can rebuild the identical key `cacheKey` wrote.
 */
export async function handleTextFeedback(request, env, cors) {
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
	// put in the AI route) and drop it. Deleting a missing key is a no-op, so a
	// stale or already-expired entry still reports success.
	const cKey = await cacheKey(['text', subject, documentName]);
	await env.RATE_LIMIT_KV.delete(cKey);

	return jsonResponse({ ok: true }, 200, cors);
}
