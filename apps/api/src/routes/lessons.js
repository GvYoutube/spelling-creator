// Lesson-hub endpoints, backed by Supabase Postgres via its REST API. The browser
// never touches the database directly — it calls these Worker routes, which hold
// the privileged service-role key (see README "Lesson hub").

import { supabaseHeaders, verifySupabaseUser } from '../lib/supabase.js';
import { authorFromUser, clientIp, displayNameOf, isModeratorRole, verifyUserAndRole } from '../lib/auth.js';
import { bannedResponse } from '../lib/bans.js';
import { rowToLesson } from '../lib/lesson.js';
import { fetchRatingStats } from '../lib/ratings.js';
import { textResponse, jsonResponse } from '../lib/http.js';

// A user may keep at most this many private drafts (published = false) at once.
// Published lessons stay unlimited — the cap only bounds unpublished backups.
const MAX_DRAFTS = 8;

/**
 * Count a user's private drafts (published = false), optionally excluding one
 * lesson id. PUT passes the lesson being edited as `excludeId` so re-saving an
 * existing draft never counts against its author — only turning an *additional*
 * lesson into a draft beyond the cap is blocked. Returns the count, or null if the
 * store couldn't be reached, so callers fail with a 502 rather than letting the cap
 * be silently bypassed.
 */
async function countUserDrafts(env, base, userId, excludeId) {
	const filters = [`author_id=eq.${encodeURIComponent(userId)}`, 'published=eq.false', 'select=id'];
	if (excludeId) filters.push(`id=neq.${encodeURIComponent(excludeId)}`);
	let res;
	try {
		res = await fetch(`${base}/rest/v1/lessons?${filters.join('&')}`, { headers: supabaseHeaders(env) });
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	const rows = await res.json().catch(() => null);
	return Array.isArray(rows) ? rows.length : null;
}

/**
 * Lesson-hub endpoints, backed by Supabase Postgres via its REST API. The
 * browser never touches the database directly — it calls these Worker routes,
 * which hold the privileged service-role key (see README "Lesson hub").
 *
 *   GET  /lessons        public  -> { lessons: LessonSummary[] }   (published only, newest first)
 *   GET  /lessons/mine   Bearer  -> { lessons: LessonSummary[] }   (caller's own, incl. drafts)
 *   GET  /lessons/:id    public  -> { lesson: Lesson }             (includes doc; drafts too)
 *   POST /lessons        Bearer  -> { lesson: LessonSummary }      (verified JWT; body.published picks draft/hub)
 *   PUT  /lessons/:id    Bearer  -> { lesson: LessonSummary }      (author only; body.published may flip draft<->hub)
 *
 * A LessonSummary carries `published` (false = draft, kept out of the public listing).
 * Each user may hold at most MAX_DRAFTS private drafts at once (published lessons are
 * unlimited); a save that would exceed it is rejected with 409.
 * Errors are short plain-text reasons so the frontend can surface res.text().
 */
export async function handleLessons(request, env, url, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}

	const base = env.SUPABASE_URL.replace(/\/$/, '');
	// Everything after "/lessons": "" for the collection, "/<id>" for one lesson.
	const rest = url.pathname.replace(/\/$/, '').slice('/lessons'.length);
	const id = rest.startsWith('/') ? decodeURIComponent(rest.slice(1)) : '';

	// GET /lessons/mine — the signed-in user's own lessons (drafts and published),
	// newest first, so the hub can show them their drafts. Requires a valid Supabase
	// session JWT; the listing is scoped to the verified user's own rows. The doc is
	// excluded (as in the public listing) to keep the payload small.
	if (request.method === 'GET' && id === 'mine') {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in to see your lessons.', 401, cors);

		const query = `author_id=eq.${encodeURIComponent(
			user.id,
		)}&select=id,author_id,title,author,section_count,published,created_at&order=created_at.desc`;
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load your lessons.', 502, cors);
		const rows = await res.json().catch(() => []);
		const lessons = (Array.isArray(rows) ? rows : []).map((r) => rowToLesson(r, false));
		return jsonResponse({ lessons }, 200, cors);
	}

	// GET /lessons/:id — one lesson, including its full editor doc. Returns drafts
	// too (so an author can load one for editing, and an unlisted-style link works);
	// drafts are kept out of the public *listing* below, not addressable-by-id reads.
	//
	// Shadowbanned lessons are the exception: they 404 to the public, exactly as if
	// they didn't exist, but stay readable to their author (who must not realise
	// they're hidden) and to moderators/admins (who manage them). So we only verify
	// a JWT when the row turns out to be shadowbanned — public reads stay token-free.
	if (request.method === 'GET' && id) {
		const query = `id=eq.${encodeURIComponent(id)}&select=id,author_id,title,author,section_count,published,shadowbanned,author_ip,created_at,doc&limit=1`;
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Lesson not found.', 404, cors);
		}
		const row = rows[0];
		// The lesson's average star rating + how many ratings it has, shown on the
		// lesson page. A store hiccup degrades to "no ratings" inside the helper.
		const { average: avgRating, count: ratingCount } = await fetchRatingStats(env, base, id);
		if (row.shadowbanned) {
			const { user, role } = await verifyUserAndRole(env, base, request);
			const isOwner = user && user.id === row.author_id;
			if (!isOwner && !isModeratorRole(role)) {
				return textResponse('Lesson not found.', 404, cors);
			}
			// Moderators/admins get the author IP (for the "ban by IP" action); the
			// author themselves does not.
			return jsonResponse({ lesson: { ...rowToLesson(row, true, isModeratorRole(role)), avgRating, ratingCount } }, 200, cors);
		}
		return jsonResponse({ lesson: { ...rowToLesson(row, true), avgRating, ratingCount } }, 200, cors);
	}

	// GET /lessons — public listing, newest first. Only published lessons appear;
	// drafts (published = false) are filtered out so they stay private to their
	// author. The doc (which can be large, holding base64 image data) is deliberately
	// excluded; section_count gives the summary its count without shipping every block.
	if (request.method === 'GET') {
		const query =
			'published=eq.true&shadowbanned=eq.false&select=id,author_id,title,author,section_count,published,created_at&order=created_at.desc';
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load lessons.', 502, cors);
		const rows = await res.json().catch(() => []);
		const lessons = (Array.isArray(rows) ? rows : []).map((r) => rowToLesson(r, false));
		return jsonResponse({ lessons }, 200, cors);
	}

	// POST /lessons — save a lesson to the cloud. Requires a valid Supabase session
	// JWT; the author is derived from the verified user, never from the request body.
	// `published` selects whether the lesson is shared on the public hub (true) or
	// kept as a private draft backup (false); it defaults to true so an older client
	// that omits the flag still publishes.
	if (request.method === 'POST' && !id) {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in before saving.', 401, cors);

		// Banned users (by IP or display name) can't publish new lessons.
		const banned = await bannedResponse(env, base, request, user, cors);
		if (banned) return banned;

		// Every author needs a display name so we never expose an email on the hub.
		// The client forces this at sign-up; re-check here so it can't be bypassed.
		if (!displayNameOf(user)) {
			return textResponse('Please choose a display name before publishing.', 403, cors);
		}

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const doc = body && body.doc;
		if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sections) || doc.sections.length === 0) {
			return textResponse('Add at least one section before saving.', 400, cors);
		}
		const title = (body.title || doc.title || 'Untitled Lesson').toString().slice(0, 300);
		const published = body.published !== false;

		// Cap private drafts: a new draft is rejected once the author already has
		// MAX_DRAFTS. Published lessons are unlimited, so this only runs for drafts.
		if (!published) {
			const drafts = await countUserDrafts(env, base, user.id);
			if (drafts === null) return textResponse('Could not reach the lesson store.', 502, cors);
			if (drafts >= MAX_DRAFTS) {
				return textResponse(`You can keep at most ${MAX_DRAFTS} private drafts. Publish or delete one before saving another.`, 409, cors);
			}
		}

		const insert = {
			author_id: user.id,
			author: authorFromUser(user),
			title,
			doc,
			published,
			// Recorded so an admin can later ban the address from a lesson of theirs.
			author_ip: clientIp(request) || null,
		};

		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?select=id,author_id,title,author,section_count,published,created_at`, {
				method: 'POST',
				headers: {
					...supabaseHeaders(env),
					'Content-Type': 'application/json',
					Prefer: 'return=representation',
				},
				body: JSON.stringify(insert),
			});
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not save the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Could not save the lesson.', 502, cors);
		}
		return jsonResponse({ lesson: rowToLesson(rows[0], false) }, 201, cors);
	}

	// PUT /lessons/:id — update a lesson the signed-in user already saved to the
	// cloud. Requires a valid Supabase session JWT, and the verified user must be the
	// lesson's author: the PATCH is filtered on both id AND author_id, so a
	// request from anyone other than the author matches no rows and is rejected
	// with 403. The title, doc and published flag are mutable (so a draft can be
	// published, or a published lesson pulled back to a draft); author and created_at
	// stay put. `published` is only changed when the body includes a boolean for it,
	// so an older client that omits it leaves the lesson's current state alone.
	if (request.method === 'PUT' && id) {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in before editing.', 401, cors);

		// Banned users (by IP or display name) can't edit lessons either.
		const banned = await bannedResponse(env, base, request, user, cors);
		if (banned) return banned;

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const doc = body && body.doc;
		if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sections) || doc.sections.length === 0) {
			return textResponse('Add at least one section before saving.', 400, cors);
		}
		const title = (body.title || doc.title || 'Untitled Lesson').toString().slice(0, 300);
		const patch = { title, doc };
		if (typeof body.published === 'boolean') patch.published = body.published;

		// Cap private drafts: block an update that would leave this lesson a draft once
		// the author is already at MAX_DRAFTS *other* drafts. Excluding this lesson lets
		// an existing draft be re-saved freely; only pulling an additional published
		// lesson back to a draft beyond the cap is rejected.
		if (patch.published === false) {
			const drafts = await countUserDrafts(env, base, user.id, id);
			if (drafts === null) return textResponse('Could not reach the lesson store.', 502, cors);
			if (drafts >= MAX_DRAFTS) {
				return textResponse(`You can keep at most ${MAX_DRAFTS} private drafts. Publish or delete one before saving another.`, 409, cors);
			}
		}

		let res;
		try {
			res = await fetch(
				`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(id)}&author_id=eq.${encodeURIComponent(
					user.id,
				)}&select=id,author_id,title,author,section_count,published,created_at`,
				{
					method: 'PATCH',
					headers: {
						...supabaseHeaders(env),
						'Content-Type': 'application/json',
						Prefer: 'return=representation',
					},
					body: JSON.stringify(patch),
				},
			);
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not save the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		// No row matched id+author_id: the lesson doesn't exist, or it isn't the
		// signed-in user's to edit. Either way, don't reveal which.
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('You can only edit lessons you published.', 403, cors);
		}
		return jsonResponse({ lesson: rowToLesson(rows[0], false) }, 200, cors);
	}

	// DELETE /lessons/:id — remove a lesson the signed-in user published. Requires
	// a valid Supabase session JWT, and the verified user must be the lesson's
	// author.
	//
	// A lesson may have comments, which carry a foreign key to it. schema.sql
	// declares that FK `on delete cascade`, but a database created before that
	// cascade was added wouldn't have it — there, deleting a lesson that still has
	// comments would fail. So we do it in three ownership-gated steps that work
	// regardless of the deployed constraint: (1) confirm the lesson is the caller's
	// (filtering on id AND author_id — a non-owner matches nothing and gets 403),
	// (2) clear its comments, (3) delete the lesson. Step 2 is a harmless no-op
	// when the FK already cascades.
	if (request.method === 'DELETE' && id) {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in before deleting.', 401, cors);

		// (1) Ownership check. We must confirm the lesson is the caller's before
		// touching its comments, since the comment delete below can't itself filter
		// on the lesson's author.
		let ownRes;
		try {
			ownRes = await fetch(
				`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(id)}&author_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`,
				{ headers: supabaseHeaders(env) },
			);
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!ownRes.ok) return textResponse('Could not delete the lesson.', 502, cors);
		const ownRows = await ownRes.json().catch(() => []);
		// No row matched id+author_id: the lesson doesn't exist, or it isn't the
		// signed-in user's to delete. Either way, don't reveal which.
		if (!Array.isArray(ownRows) || ownRows.length === 0) {
			return textResponse('You can only delete lessons you published.', 403, cors);
		}

		// (2) Clear the lesson's comments so the lesson delete can't be blocked by
		// the FK on a non-cascading database.
		let commentsRes;
		try {
			commentsRes = await fetch(`${base}/rest/v1/comments?lesson_id=eq.${encodeURIComponent(id)}`, {
				method: 'DELETE',
				headers: supabaseHeaders(env),
			});
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!commentsRes.ok) return textResponse('Could not delete the lesson.', 502, cors);

		// (3) Delete the lesson itself (still filtered on author_id as defence in
		// depth). return=representation lets us confirm a row was actually removed.
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(id)}&author_id=eq.${encodeURIComponent(user.id)}&select=id`, {
				method: 'DELETE',
				headers: {
					...supabaseHeaders(env),
					Prefer: 'return=representation',
				},
			});
		} catch (e) {
			return textResponse('Could not reach the lesson store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not delete the lesson.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('You can only delete lessons you published.', 403, cors);
		}
		return jsonResponse({ ok: true }, 200, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}
