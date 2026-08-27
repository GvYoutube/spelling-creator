// The X-Admin-Token check, in one place.
//
// Two route files gate on this header — the one-time backfills in routes/admin.js
// and /_diagnostics — and they each had their own copy of the comparison. A
// security check written twice is a security check that will one day be improved
// once, so it lives here instead.

/**
 * Whether the token a caller presented is the configured one.
 *
 * The comparison is over SHA-256 digests rather than over the strings, which is
 * what makes it constant-time *including* in the lengths. A plain byte loop has
 * to return early when two strings differ in length, and that early return is
 * itself the leak: an attacker who can time enough requests learns how long the
 * secret is, which is the first thing they would otherwise have to guess. Two
 * digests are always 32 bytes, so the loop below always runs the same number of
 * times whatever it was given.
 *
 * Async for the same reason: `crypto.subtle` is the one hash both runtimes have,
 * and it only comes as a promise. Every caller is a handler that was already
 * awaiting something.
 *
 * @param {string} provided  The value of the request's X-Admin-Token header.
 * @param {string} expected  env.ADMIN_MIGRATE_TOKEN.
 * @returns {Promise<boolean>}
 */
export async function adminTokenMatches(provided, expected) {
	// An unconfigured token matches nothing, rather than matching the empty
	// header a caller sending nothing at all would produce.
	if (!expected) return false;

	const encoder = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(String(provided ?? ''))),
		crypto.subtle.digest('SHA-256', encoder.encode(String(expected))),
	]);
	const left = new Uint8Array(a);
	const right = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
	return diff === 0;
}
