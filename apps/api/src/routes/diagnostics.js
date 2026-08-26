// Two endpoints about the health of the instance itself.
//
//   GET /_health       Is this process up? Public, cheap, answers nothing else.
//   GET /_diagnostics  Is each dependency working, and if not, why? Gated.
//
// They are separate because they answer different questions for different
// audiences. A load balancer wants a fast yes/no about the process and should
// not be taking the database down with it when Postgres hiccups; a person
// debugging wants everything, and is willing to authenticate for it.
//
// The gate on /_diagnostics is the same X-Admin-Token the backfills use. The
// results carry no credentials, but they do carry upstream error messages that
// can name tables and buckets, and that is not something to hand to anyone who
// asks. When no token is configured the endpoint refuses rather than opening —
// an instance with no admin token is not thereby more public.
//
// The same checks run at startup and print to the log (see node/server.js), so
// being locked out of this endpoint never leaves an operator with no way to see
// what is wrong.

import { runDiagnostics, formatDiagnostics } from '../lib/diagnostics.js';
import { jsonResponse, textResponse } from '../lib/http.js';

/** Constant-time compare, so the token check leaks neither length nor content. */
function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * GET /_health — the process is running and routing.
 *
 * Deliberately checks nothing else. A health check that fails when a dependency
 * is briefly unavailable makes an orchestrator restart a process that was fine,
 * which turns a small outage into a longer one.
 */
export function handleHealth(cors) {
	return jsonResponse({ ok: true }, 200, cors);
}

/**
 * GET /_diagnostics — every dependency, and what is wrong with it.
 *
 * `?format=text` returns the same thing as the plain-text report the server
 * prints at startup, which is easier to read from a terminal than JSON.
 */
export async function handleDiagnostics(request, env, cors) {
	if (!env.ADMIN_MIGRATE_TOKEN) {
		return textResponse(
			'Diagnostics are not available: no ADMIN_MIGRATE_TOKEN is configured.\n' +
				'The same checks are printed to this process’s log at startup.',
			503,
			cors,
		);
	}
	const provided = request.headers.get('X-Admin-Token') || '';
	if (!timingSafeEqual(provided, env.ADMIN_MIGRATE_TOKEN)) {
		return textResponse('Forbidden.', 403, cors);
	}

	const result = await runDiagnostics(env);
	// 200 either way: the request succeeded, and the answer is the body. A failing
	// check is not a failed request, and returning 5xx here would make this
	// endpoint indistinguishable from the outage it is describing.
	if (new URL(request.url).searchParams.get('format') === 'text') {
		return textResponse(formatDiagnostics(result), 200, cors);
	}
	return jsonResponse(result, 200, cors);
}
