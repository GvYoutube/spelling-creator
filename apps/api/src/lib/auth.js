// Identity helpers: reading the caller off a request, deriving the public author
// label, and looking up the moderation role. Roles are always re-derived from the
// database server-side — never trusted from the client.

import { supabaseHeaders, verifySupabaseUser } from './supabase.js';

/**
 * The display name a user chose for themselves (stored in user_metadata by the
 * profile endpoint), or '' if they haven't set one yet. Trimmed. This is the
 * ONLY name shown to other users — we never expose the email address.
 */
export function displayNameOf(user) {
	const meta = (user && user.user_metadata) || {};
	return (meta.display_name || '').toString().trim();
}

/**
 * Pick a public author label from a verified Supabase user. Uses the display
 * name the user chose; never the email address (the app forces every user to set
 * a display name before posting, so this normally has a real value). Falls back
 * to 'Anonymous' only for legacy rows that predate display names. The author is
 * taken from the verified user, never from client-supplied input.
 */
export function authorFromUser(user) {
	return displayNameOf(user) || 'Anonymous';
}

/**
 * The client IP a request arrived from, per Cloudflare's `cf-connecting-ip`
 * header (the same source the rate limiter uses). Recorded on new content so an
 * admin can later ban that address, and checked against `banned_ips`.
 */
export function clientIp(request) {
	return request.headers.get('cf-connecting-ip') || '';
}

/**
 * Pull the `Authorization: Bearer <jwt>` token off a request, or '' if absent.
 */
export function bearerToken(request) {
	const auth = request.headers.get('Authorization') || '';
	return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
}

/**
 * The privilege tier of a verified user: 'admin', 'moderator', or null for a
 * plain author. Read from public.user_roles with the service-role key, so the
 * role can never be asserted by the client — it is always re-derived server-side.
 */
export async function getUserRole(env, base, userId) {
	if (!userId) return null;
	let res;
	try {
		res = await fetch(`${base}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(userId)}&select=role&limit=1`, {
			headers: supabaseHeaders(env),
		});
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	const rows = await res.json().catch(() => []);
	return Array.isArray(rows) && rows.length ? rows[0].role : null;
}

/**
 * Verify a request's Supabase JWT and look up the caller's moderation role in one
 * step. Returns { user, role } — user is null when the token is missing/invalid,
 * role is 'admin' | 'moderator' | null.
 */
export async function verifyUserAndRole(env, base, request) {
	const user = await verifySupabaseUser(env, bearerToken(request));
	if (!user) return { user: null, role: null };
	const role = await getUserRole(env, base, user.id);
	return { user, role };
}

export const isModeratorRole = (role) => role === 'moderator' || role === 'admin';
