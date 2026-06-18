// Ban checks applied at the top of every content-creating route, so a banned
// address or display name can't post anything new.

import { supabaseHeaders } from './supabase.js';
import { authorFromUser, clientIp } from './auth.js';
import { textResponse } from './http.js';

/**
 * Whether an IP address is banned (admin-issued). Checked at the top of the
 * content-creating routes so a banned address can't post anything new.
 */
export async function isIpBanned(env, base, ip) {
	if (!ip) return false;
	let res;
	try {
		res = await fetch(`${base}/rest/v1/banned_ips?ip=eq.${encodeURIComponent(ip)}&select=ip&limit=1`, {
			headers: supabaseHeaders(env),
		});
	} catch (e) {
		return false;
	}
	if (!res.ok) return false;
	const rows = await res.json().catch(() => []);
	return Array.isArray(rows) && rows.length > 0;
}

/**
 * Whether a display name is banned (moderator-issued). Names are stored
 * normalised (lower-cased, trimmed); compare the same way.
 */
export async function isNameBanned(env, base, name) {
	const key = (name || '').trim().toLowerCase();
	if (!key) return false;
	let res;
	try {
		res = await fetch(`${base}/rest/v1/banned_names?name_lower=eq.${encodeURIComponent(key)}&select=name_lower&limit=1`, {
			headers: supabaseHeaders(env),
		});
	} catch (e) {
		return false;
	}
	if (!res.ok) return false;
	const rows = await res.json().catch(() => []);
	return Array.isArray(rows) && rows.length > 0;
}

/**
 * Reject a content-creating request from a banned user. Returns a Response (the
 * 403 to send) when the caller's IP or display name is banned, or null when they
 * are clear to proceed. Kept in one place so every write path bans identically.
 */
export async function bannedResponse(env, base, request, user, cors) {
	if (await isIpBanned(env, base, clientIp(request))) {
		return textResponse('Your access has been suspended.', 403, cors);
	}
	if (await isNameBanned(env, base, authorFromUser(user))) {
		return textResponse('Your access has been suspended.', 403, cors);
	}
	return null;
}
