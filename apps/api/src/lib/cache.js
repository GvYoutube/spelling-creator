/**
 * Build a stable, case-insensitive cache key from the inputs that actually
 * determine the AI answer. Each part is trimmed and lower-cased before hashing,
 * so the same information in different casing or with surrounding whitespace
 * maps to the same entry. The Turnstile token and client IP are deliberately
 * excluded — they gate access but do not change the generated content. The
 * inputs are hashed (rather than concatenated) so the key stays within KV's
 * key-length limit even when `sectionText` is long.
 */
export async function cacheKey(parts) {
	const norm = parts
		.map((p) =>
			String(p ?? '')
				.trim()
				.toLowerCase(),
		)
		.join(' ');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `cache:${hex}`;
}
