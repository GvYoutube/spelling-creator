// Small response builders shared across every route. Both carry the request's
// CORS headers so a cross-origin caller from our own domain can read the result.

/**
 * Build a plain-text error Response carrying the request's CORS headers. The
 * client surfaces `res.text()` directly, so the message is user-facing.
 */
export function textResponse(msg, status, cors) {
	const headers = new Headers(cors);
	headers.set('Content-Type', 'text/plain');
	return new Response(msg, { status, headers });
}

/**
 * Build a JSON Response carrying the request's CORS headers. Used by the lesson
 * hub endpoints, which return JSON on success and plain text (via textResponse)
 * on error — matching the AI/Pixabay convention the frontend already surfaces.
 */
export function jsonResponse(obj, status, cors) {
	const headers = new Headers(cors);
	headers.set('Content-Type', 'application/json');
	return new Response(JSON.stringify(obj), { status, headers });
}
