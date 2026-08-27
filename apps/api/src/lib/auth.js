// Identity helpers: reading the caller off a request, deriving the public author
// label, and looking up the moderation role. Roles are always re-derived from the
// database server-side — never trusted from the client.

import { clientIp as platformClientIp } from '../platform/index.js';
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
 * The client IP a request arrived from (the same source the rate limiter uses).
 * Recorded on new content so an admin can later ban that address, and checked
 * against `banned_ips`.
 *
 * Which header carries it is the host's business, not this module's: Cloudflare
 * sets `cf-connecting-ip` and overwrites any client-supplied copy, where a
 * self-hosted instance behind its own proxy has a different trusted header. So
 * the answer comes from the platform seam — and it takes `env` for that reason,
 * not because identity has anything to do with bindings.
 */
export function clientIp(env, request) {
	return platformClientIp(env, request);
}

/**
 * Pull the `Authorization: Bearer <jwt>` token off a request, or '' if absent.
 */
export function bearerToken(request) {
	const auth = request.headers.get('Authorization') || '';
	return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
}

/**
 * The privilege tier of a verified user, and whether we actually know it.
 *
 * `known` is false when the lookup itself failed — the store was unreachable,
 * or answered with something other than a row list. That is a different thing
 * from a user who has no row, and the difference matters wherever an absent
 * role *grants* something rather than withholding it: gating a moderator route
 * on `role` fails closed when the answer is null, but refusing to reset another
 * admin's password does not, and a caller that cannot tell the two apart would
 * take a peer's account whenever the database hiccuped.
 *
 * Read from public.user_roles with the service-role key, so the role can never
 * be asserted by the client — it is always re-derived server-side.
 *
 * @returns {Promise<{ known: boolean, role: 'admin' | 'moderator' | null }>}
 */
export async function lookupUserRole(env, base, userId) {
	if (!userId) return { known: true, role: null };
	let res;
	try {
		res = await fetch(`${base}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(userId)}&select=role&limit=1`, {
			headers: supabaseHeaders(env),
		});
	} catch (e) {
		return { known: false, role: null };
	}
	if (!res.ok) return { known: false, role: null };
	const rows = await res.json().catch(() => null);
	if (!Array.isArray(rows)) return { known: false, role: null };
	return { known: true, role: rows.length ? rows[0].role : null };
}

/**
 * The privilege tier of a verified user: 'admin', 'moderator', or null for a
 * plain author — with a failed lookup reported as null.
 *
 * That is the right answer for every gate that asks "may this caller do the
 * privileged thing?", since an unknown role must not be allowed through. Use
 * `lookupUserRole` where a null would instead permit something.
 */
export async function getUserRole(env, base, userId) {
	return (await lookupUserRole(env, base, userId)).role;
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
