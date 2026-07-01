// Follow endpoints, backed by Supabase Postgres. A follow is one row in the
// `follows` table (follower_id -> following_id). Following someone notifies them
// (a `follow` notification), and the "activity from people you follow" feed merges
// the recent lessons and comments of everyone the caller follows. Writes go
// through the service-role key like the rest of the API.

import { supabaseHeaders, verifySupabaseUser, fetchPublicUser } from '../lib/supabase.js';
import { authorFromUser, bearerToken } from '../lib/auth.js';
import { createNotification } from './notifications.js';
import { textResponse, jsonResponse } from '../lib/http.js';

// The following feed merges recent lessons + comments from followed users; cap
// each source and the merged stream so a user who follows many people still gets
// a bounded, fast response (mirrors the per-user Atom feed's cap in users.js).
const FEED_LIMIT = 50;

// Cap the followers/following lists. Each id is resolved to a profile via the
// Admin API, so this also bounds how many of those lookups one request fans out.
const LIST_LIMIT = 200;

/**
 * Count the rows matching a `follows` filter without downloading them, using
 * PostgREST's exact-count header: `Prefer: count=exact` plus a `Range: 0-0` puts
 * the total in the Content-Range response header as "start-end/total" (or "* /0"
 * when empty). Returns 0 on any error so a count hiccup never fails a follow.
 */
export async function countFollows(env, base, filter) {
	let res;
	try {
		res = await fetch(`${base}/rest/v1/follows?${filter}&select=follower_id`, {
			headers: { ...supabaseHeaders(env), Prefer: 'count=exact', Range: '0-0' },
		});
	} catch (e) {
		return 0;
	}
	// A ranged count comes back 206 Partial Content (still res.ok), 200 when empty.
	if (!res.ok) return 0;
	const range = res.headers.get('content-range') || '';
	const total = range.includes('/') ? parseInt(range.split('/')[1], 10) : 0;
	return Number.isFinite(total) ? total : 0;
}

/**
 * Whether `followerId` currently follows `followingId`. Returns false on error or
 * when either id is missing (e.g. an anonymous profile view).
 */
export async function isFollowing(env, base, followerId, followingId) {
	if (!followerId || !followingId) return false;
	let res;
	try {
		res = await fetch(
			`${base}/rest/v1/follows?follower_id=eq.${encodeURIComponent(followerId)}&following_id=eq.${encodeURIComponent(
				followingId,
			)}&select=follower_id&limit=1`,
			{ headers: supabaseHeaders(env) },
		);
	} catch (e) {
		return false;
	}
	if (!res.ok) return false;
	const rows = await res.json().catch(() => []);
	return Array.isArray(rows) && rows.length > 0;
}

/**
 * Follow / unfollow a user.
 *
 *   POST   /profiles/:id/follow   Bearer -> { following: true,  followerCount }
 *   DELETE /profiles/:id/follow   Bearer -> { following: false, followerCount }
 *
 * The follower is taken from the verified session, never the request body. You
 * can't follow yourself (400) or a user who doesn't exist (404). Following is
 * idempotent — re-following is a no-op and does NOT re-notify — while a genuinely
 * new follow notifies the followed user with a `follow` notification. Notification
 * failures are swallowed so they can never fail the follow itself. Errors are
 * short plain-text reasons so the frontend can surface res.text().
 */
export async function handleFollow(request, env, targetId, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (request.method !== 'POST' && request.method !== 'DELETE') {
		return textResponse('Method not allowed.', 405, cors);
	}
	if (!targetId) return textResponse('Missing user id.', 400, cors);

	const user = await verifySupabaseUser(env, bearerToken(request));
	if (!user) return textResponse('Please sign in to follow people.', 401, cors);
	if (user.id === targetId) return textResponse('You can’t follow yourself.', 400, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');

	// The target must exist. The FK would reject an orphan follow anyway, but this
	// returns a clear 404 instead of a generic store error.
	const target = await fetchPublicUser(env, base, targetId);
	if (!target) return textResponse('Profile not found.', 404, cors);

	const followerFilter = `following_id=eq.${encodeURIComponent(targetId)}`;

	if (request.method === 'DELETE') {
		let res;
		try {
			res = await fetch(
				`${base}/rest/v1/follows?follower_id=eq.${encodeURIComponent(user.id)}&following_id=eq.${encodeURIComponent(targetId)}`,
				{ method: 'DELETE', headers: supabaseHeaders(env) },
			);
		} catch (e) {
			return textResponse('Could not reach the server.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not unfollow.', 502, cors);
		const followerCount = await countFollows(env, base, followerFilter);
		return jsonResponse({ following: false, followerCount }, 200, cors);
	}

	// POST — follow. `resolution=ignore-duplicates` makes the insert an ON CONFLICT
	// DO NOTHING, and `return=representation` means an empty result signals the row
	// already existed — so a repeat follow doesn't send a second notification.
	let res;
	try {
		res = await fetch(`${base}/rest/v1/follows?select=follower_id`, {
			method: 'POST',
			headers: {
				...supabaseHeaders(env),
				'Content-Type': 'application/json',
				Prefer: 'return=representation,resolution=ignore-duplicates',
			},
			body: JSON.stringify({ follower_id: user.id, following_id: targetId }),
		});
	} catch (e) {
		return textResponse('Could not reach the server.', 502, cors);
	}
	if (!res.ok) return textResponse('Could not follow.', 502, cors);
	const inserted = await res.json().catch(() => []);
	const isNew = Array.isArray(inserted) && inserted.length > 0;

	// A genuinely new follow notifies the followed user; the link opens the
	// follower's profile. Swallow failures so they can't fail the follow.
	if (isNew) {
		await createNotification(env, base, {
			userId: targetId,
			type: 'follow',
			title: `${authorFromUser(user)} started following you`,
			link: `/users/${user.id}`,
		}).catch(() => {});
	}

	const followerCount = await countFollows(env, base, followerFilter);
	return jsonResponse({ following: true, followerCount }, isNew ? 201 : 200, cors);
}

/**
 * List a user's followers or the users they follow.
 *
 *   GET /profiles/:id/followers   public -> { users: PublicUser[] }
 *   GET /profiles/:id/following   public -> { users: PublicUser[] }
 *
 * Public, like the profile read itself. `direction` is 'followers' (the users who
 * follow :id) or 'following' (the users :id follows). Rows come newest-edge-first
 * and are capped at LIST_LIMIT; each id is resolved to its public profile shape
 * ({ id, displayName, bio }) via the Admin API, dropping any that no longer resolve
 * (e.g. an account deleted mid-list). Errors are short plain-text reasons.
 */
export async function handleFollowList(request, env, targetId, direction, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (request.method !== 'GET') return textResponse('Method not allowed.', 405, cors);
	if (!targetId) return textResponse('Missing user id.', 400, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');

	// followers -> match rows whose following_id is :id, return their follower_id.
	// following -> match rows whose follower_id is :id, return their following_id.
	const [filter, selectCol] =
		direction === 'followers'
			? [`following_id=eq.${encodeURIComponent(targetId)}`, 'follower_id']
			: [`follower_id=eq.${encodeURIComponent(targetId)}`, 'following_id'];

	let ids = [];
	try {
		const res = await fetch(`${base}/rest/v1/follows?${filter}&select=${selectCol}&order=created_at.desc&limit=${LIST_LIMIT}`, {
			headers: supabaseHeaders(env),
		});
		if (res.ok) {
			const rows = await res.json().catch(() => []);
			ids = (Array.isArray(rows) ? rows : []).map((r) => r[selectCol]).filter(Boolean);
		}
	} catch (e) {
		return textResponse('Could not reach the server.', 502, cors);
	}

	// Resolve each id to its public profile in parallel, preserving order and
	// dropping any that no longer resolve.
	const users = (await Promise.all(ids.map((uid) => fetchPublicUser(env, base, uid)))).filter(Boolean);
	return jsonResponse({ users }, 200, cors);
}

/**
 * GET /following/activity   Bearer -> { activity: FeedItem[] }
 *
 * The signed-in user's home feed: recent lessons and comments from everyone they
 * follow, merged newest-first and capped. Each item is { id, title, summary, link,
 * updated } — the same shape the dashboard and profile activity lists already
 * render, so it plugs straight into the frontend's <FeedList>. The actor's name
 * comes from the denormalised `author` on each row (no per-author lookup). Returns
 * an empty feed when the user follows no one. Errors are short plain-text reasons.
 */
export async function handleFollowingFeed(request, env, url, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (request.method !== 'GET') return textResponse('Method not allowed.', 405, cors);

	const user = await verifySupabaseUser(env, bearerToken(request));
	if (!user) return textResponse('Please sign in to see your following feed.', 401, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');

	// Who the caller follows.
	let following = [];
	try {
		const res = await fetch(`${base}/rest/v1/follows?follower_id=eq.${encodeURIComponent(user.id)}&select=following_id`, {
			headers: supabaseHeaders(env),
		});
		if (res.ok) {
			const rows = await res.json().catch(() => []);
			following = (Array.isArray(rows) ? rows : []).map((r) => r.following_id).filter(Boolean);
		}
	} catch (e) {
		return textResponse('Could not reach the server.', 502, cors);
	}
	if (following.length === 0) return jsonResponse({ activity: [] }, 200, cors);

	// PostgREST `in.(...)` list of the followed ids (UUIDs — safe unencoded).
	const inList = `(${following.map((id) => encodeURIComponent(id)).join(',')})`;
	const entries = [];

	// Lessons those users published (public + non-shadowbanned, matching the hub).
	try {
		const q = `author_id=in.${inList}&published=eq.true&shadowbanned=eq.false&select=id,title,author,created_at&order=created_at.desc&limit=${FEED_LIMIT}`;
		const res = await fetch(`${base}/rest/v1/lessons?${q}`, { headers: supabaseHeaders(env) });
		if (res.ok) {
			for (const row of (await res.json().catch(() => [])) || []) {
				if (!row || !row.id) continue;
				const who = (row.author || 'Someone').trim() || 'Someone';
				entries.push({
					id: `lesson:${row.id}`,
					title: row.title || 'Untitled Lesson',
					summary: `${who} published a lesson.`,
					link: `/hub/${row.id}`,
					updated: row.created_at,
				});
			}
		}
	} catch (e) {
		// Skip lessons on error; comments (and an empty feed) still render.
	}

	// Comments those users posted.
	try {
		const q = `author_id=in.${inList}&select=id,lesson_id,author,body,created_at&order=created_at.desc&limit=${FEED_LIMIT}`;
		const res = await fetch(`${base}/rest/v1/comments?${q}`, { headers: supabaseHeaders(env) });
		if (res.ok) {
			for (const row of (await res.json().catch(() => [])) || []) {
				if (!row || !row.id || !row.lesson_id) continue;
				const who = (row.author || 'Someone').trim() || 'Someone';
				entries.push({
					id: `comment:${row.id}`,
					title: `${who} commented`,
					summary: row.body || '',
					link: `/hub/${row.lesson_id}`,
					updated: row.created_at,
				});
			}
		}
	} catch (e) {
		// Skip comments on error.
	}

	// Merge newest-first and cap the combined stream.
	entries.sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0));
	return jsonResponse({ activity: entries.slice(0, FEED_LIMIT) }, 200, cors);
}
