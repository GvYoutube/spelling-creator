// Server-side Cloudflare Turnstile verification — proves an AI/image request came
// from our own domain (via the hostname Cloudflare binds to the solved challenge,
// which the client cannot forge), gating access without consuming AI quota.

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
export async function verifyTurnstile(token, secret, allowedHostnames, remoteIp) {
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
