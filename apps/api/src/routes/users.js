// Public user-profile endpoints. Profiles are keyed by the Supabase user id (the
// same `author_id` carried on every lesson/comment), so they stay valid even when
// a display name changes. All reads are public — no auth.

import { supabaseHeaders, fetchPublicUser, verifySupabaseUser } from '../lib/supabase.js';
import { bearerToken } from '../lib/auth.js';
import { countFollows, isFollowing } from './follows.js';
import { rowToLesson } from '../lib/lesson.js';
import { xmlEscape } from '../lib/xml.js';
import { richTextToPlain } from '../lib/richtext.js';
import { textResponse, jsonResponse } from '../lib/http.js';

/**
 * Public user-profile endpoints. Profiles are keyed by the Supabase user id (the
 * same `author_id` carried on every lesson/comment), so they stay valid even when
 * a display name changes. All reads are public — no auth. The data lives under
 * /profiles so it never collides with the SPA's /users/:id page (the same split
 * the lesson data at /lessons / page at /hub already uses).
 *
 *   GET /profiles/:id            -> { user: { id, displayName, bio, followerCount, followingCount, isFollowing }, lessons: LessonSummary[] }
 *   GET /profiles/:id/feed.xml   -> Atom feed of the user's lessons + comments ("RSS" in the UI)
 *
 * The profile lists only the user's published, non-shadowbanned lessons (the same
 * visibility rule as the public hub). The `user` object also carries follower and
 * following counts; `isFollowing` reflects whether the *caller* follows this
 * profile and is only meaningful when a Bearer token is supplied (false otherwise,
 * since the profile read is public). Errors are short plain-text reasons.
 */
export async function handleUsers(request, env, url, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (request.method !== 'GET') return textResponse('Method not allowed.', 405, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');
	// Everything after "/profiles": "/<id>" for a profile, "/<id>/feed.xml" for the feed.
	const rest = url.pathname.replace(/\/$/, '').slice('/profiles'.length);
	const feed = rest.endsWith('/feed.xml');
	const idPart = feed ? rest.slice(0, -'/feed.xml'.length) : rest;
	const id = idPart.startsWith('/') ? decodeURIComponent(idPart.slice(1)) : '';
	if (!id) return textResponse('Missing user id.', 400, cors);

	if (feed) return userFeed(env, base, url, id, cors);

	// GET /profiles/:id — the profile: the user's public fields plus their published
	// lessons, newest first (the doc is excluded, as in the public listing).
	const user = await fetchPublicUser(env, base, id);
	if (!user) return textResponse('Profile not found.', 404, cors);

	// Follower/following counts, and — when the request carries a session — whether
	// the caller already follows this profile (so the UI can show Follow vs
	// Following). The profile read stays public: no token just means isFollowing is
	// false. Run these alongside the lesson list; a follow-count hiccup returns 0.
	const caller = await verifySupabaseUser(env, bearerToken(request));
	const [followerCount, followingCount, following] = await Promise.all([
		countFollows(env, base, `following_id=eq.${encodeURIComponent(id)}`),
		countFollows(env, base, `follower_id=eq.${encodeURIComponent(id)}`),
		caller ? isFollowing(env, base, caller.id, id) : Promise.resolve(false),
	]);
	user.followerCount = followerCount;
	user.followingCount = followingCount;
	user.isFollowing = following;

	const query = `author_id=eq.${encodeURIComponent(
		id,
	)}&published=eq.true&shadowbanned=eq.false&select=id,author_id,title,author,section_count,published,created_at&order=created_at.desc`;
	let lessons = [];
	try {
		const res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
		if (res.ok) {
			const rows = await res.json().catch(() => []);
			lessons = (Array.isArray(rows) ? rows : []).map((r) => rowToLesson(r));
		}
	} catch (e) {
		// Profile still loads without the lesson list; show what we have.
	}

	return jsonResponse({ user, lessons }, 200, cors);
}

/**
 * GET /profiles/:id/feed.xml — an Atom 1.0 activity feed for one user, merging
 * their published lessons and their comments, newest first (capped). Built and
 * escaped the same way as the sitemap. Surfaced in the UI as "RSS" (the terms are
 * used interchangeably). The <alternate> link points at the human /users/:id page.
 * On a Supabase hiccup we still return a valid, empty-ish feed rather than failing,
 * matching handleSitemap.
 */
async function userFeed(env, base, url, id, cors) {
	const user = await fetchPublicUser(env, base, id);
	if (!user) return textResponse('Profile not found.', 404, cors);

	const origin = url.origin;
	const selfUrl = `${origin}/profiles/${encodeURIComponent(id)}/feed.xml`;
	const profileUrl = `${origin}/users/${encodeURIComponent(id)}`;
	const entries = [];

	// Lessons the user published.
	try {
		const q = `author_id=eq.${encodeURIComponent(id)}&published=eq.true&shadowbanned=eq.false&select=id,title,created_at&order=created_at.desc&limit=50`;
		const res = await fetch(`${base}/rest/v1/lessons?${q}`, { headers: supabaseHeaders(env) });
		if (res.ok) {
			for (const row of (await res.json().catch(() => [])) || []) {
				if (!row || !row.id) continue;
				entries.push({
					id: `urn:s2c:lesson:${row.id}`,
					title: row.title || 'Untitled Lesson',
					link: `${origin}/hub/${encodeURIComponent(row.id)}`,
					summary: `${user.displayName} published the lesson “${row.title || 'Untitled Lesson'}”.`,
					createdAt: row.created_at,
				});
			}
		}
	} catch (e) {
		// Skip lessons on error; comments (and an empty feed) still render.
	}

	// Comments the user posted.
	try {
		const q = `author_id=eq.${encodeURIComponent(id)}&select=id,lesson_id,body,created_at&order=created_at.desc&limit=50`;
		const res = await fetch(`${base}/rest/v1/comments?${q}`, { headers: supabaseHeaders(env) });
		if (res.ok) {
			for (const row of (await res.json().catch(() => [])) || []) {
				if (!row || !row.id) continue;
				entries.push({
					id: `urn:s2c:comment:${row.id}`,
					title: `Comment by ${user.displayName}`,
					link: row.lesson_id ? `${origin}/hub/${encodeURIComponent(row.lesson_id)}` : profileUrl,
					// Comment bodies are rich-text HTML. An Atom <summary> without a
					// type="html" attribute is plain text, so the markup would reach feed
					// readers as literal, escaped tags — flatten it to the words instead.
					summary: richTextToPlain(row.body || ''),
					createdAt: row.created_at,
				});
			}
		}
	} catch (e) {
		// Skip comments on error.
	}

	// Merge newest-first and cap the combined stream.
	entries.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
	const top = entries.slice(0, 50);
	// The feed's <updated> is the newest entry's timestamp (or epoch if empty).
	const updated = new Date(top.length && top[0].createdAt ? top[0].createdAt : 0).toISOString();

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<title>${xmlEscape(user.displayName)} — activity</title>
	<subtitle>Lessons and comments from ${xmlEscape(user.displayName)}</subtitle>
	<id>${xmlEscape(profileUrl)}</id>
	<link rel="self" type="application/atom+xml" href="${xmlEscape(selfUrl)}"/>
	<link rel="alternate" type="text/html" href="${xmlEscape(profileUrl)}"/>
	<updated>${updated}</updated>
	<author><name>${xmlEscape(user.displayName)}</name></author>
${top
	.map((e) => {
		const ts = new Date(e.createdAt || 0).toISOString();
		return `	<entry>
		<id>${xmlEscape(e.id)}</id>
		<title>${xmlEscape(e.title)}</title>
		<link rel="alternate" type="text/html" href="${xmlEscape(e.link)}"/>
		<updated>${ts}</updated>
		<published>${ts}</published>
		<author><name>${xmlEscape(user.displayName)}</name></author>
		<summary>${xmlEscape(e.summary)}</summary>
	</entry>`;
	})
	.join('\n')}
</feed>`;

	const headers = new Headers(cors);
	headers.set('Content-Type', 'application/atom+xml; charset=utf-8');
	headers.set('Cache-Control', 'public, max-age=3600');
	return new Response(body, { status: 200, headers });
}
