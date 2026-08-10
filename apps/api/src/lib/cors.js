// CORS handling. The Origin is reflected back only when its hostname is in the
// allow-list, so the browser permits cross-origin reads from our own domain(s)
// but not from arbitrary sites.

/**
 * The hostnames allowed to read this API cross-origin, parsed from the
 * comma-separated ALLOWED_HOSTNAMES var. Also used by the Turnstile check, which
 * confirms a solved challenge's hostname is one of these.
 */
export function allowedHostnames(env) {
	return (env.ALLOWED_HOSTNAMES || '')
		.split(',')
		.map((h) => h.trim())
		.filter(Boolean);
}

/**
 * Build CORS headers for a request. The Origin is reflected back only when its
 * hostname is in the allow-list, so the browser permits cross-origin reads from
 * our own domain(s) but not from arbitrary sites.
 */
export function corsHeaders(request, allowed) {
	const headers = new Headers();
	const origin = request.headers.get('Origin');
	if (origin) {
		let ok;
		try {
			ok = allowed.includes(new URL(origin).hostname);
		} catch {
			ok = false;
		}
		if (ok) {
			headers.set('Access-Control-Allow-Origin', origin);
			headers.set('Vary', 'Origin');
			headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
			// X-Git-Head and X-Git-Parent carry a pushed history's tip and the head it
			// expects to replace (the compare-and-swap in routes/git.js), and the same
			// tip when a pull request's pack is uploaded. Neither is a safelisted
			// header, so without naming them here the browser's preflight refuses the
			// upload — invisibly, whenever the app is served from a different origin
			// than the API. Same-origin deploys never preflight and so never noticed.
			headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Git-Head, X-Git-Parent');
			headers.set('Access-Control-Max-Age', '86400');
		}
	}
	return headers;
}
