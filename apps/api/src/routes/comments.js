// Comment endpoints for a single published lesson, backed by Supabase Postgres.
// POST is moderated through glin-profanity; replies notify the parent comment's
// author and the lesson's author.

import { supabaseHeaders, verifySupabaseUser } from '../lib/supabase.js';
import { authorFromUser, clientIp, displayNameOf } from '../lib/auth.js';
import { bannedResponse } from '../lib/bans.js';
import { profanityFilter } from '../lib/profanity.js';
import { textResponse, jsonResponse } from '../lib/http.js';
import { createNotification } from './notifications.js';

// The longest comment we accept. Comments are short discussion, not documents.
const MAX_COMMENT_LENGTH = 2000;

/**
 * Map a Supabase `comments` row to the camelCase shape the frontend expects.
 */
function rowToComment(row) {
	return {
		id: row.id,
		// The comment this one replies to, or null for a top-level comment. The
		// frontend uses it to nest replies under their parent.
		parentId: row.parent_id || null,
		// The commenter's Supabase user id — the frontend links the author name to
		// their /users/:id profile when present.
		authorId: row.author_id || null,
		author: row.author,
		body: row.body,
		createdAt: row.created_at,
	};
}

/**
 * Comment endpoints for a single published lesson, backed by Supabase Postgres.
 *
 *   GET  /lessons/:id/comments   public  -> { comments: Comment[] }   (oldest first)
 *   POST /lessons/:id/comments   Bearer  -> { comment: Comment }      (verified JWT)
 *
 * POST is moderated: the comment text is run through glin-profanity, and if it
 * contains any profanity the whole comment is rejected (422) — nothing is stored
 * and nothing is censored-and-kept. The author is derived from the verified user,
 * never from the request body. Errors are short plain-text reasons so the frontend
 * can surface res.text(), matching the rest of the API.
 *
 * A POST may carry `parentId` to reply to an existing comment on the same lesson.
 * When it does, the reply notifies the parent comment's author and the lesson's
 * author (deduplicated to a single notification when they're the same person, and
 * never notifying the replier themselves). Notification failures are swallowed so
 * they can't fail the reply itself.
 */
export async function handleComments(request, env, lessonId, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (!lessonId) return textResponse('Missing lesson id.', 400, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');

	// GET — public listing of a lesson's comments, oldest first so the thread
	// reads top to bottom.
	if (request.method === 'GET') {
		const query = `lesson_id=eq.${encodeURIComponent(lessonId)}&select=id,parent_id,author_id,author,body,created_at&order=created_at.asc`;
		let res;
		try {
			res = await fetch(`${base}/rest/v1/comments?${query}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return textResponse('Could not reach the comment store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load comments.', 502, cors);
		const rows = await res.json().catch(() => []);
		const comments = (Array.isArray(rows) ? rows : []).map(rowToComment);
		return jsonResponse({ comments }, 200, cors);
	}

	// POST — add a comment. Requires a valid Supabase session JWT.
	if (request.method === 'POST') {
		const auth = request.headers.get('Authorization') || '';
		const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
		const user = await verifySupabaseUser(env, token);
		if (!user) return textResponse('Please sign in before commenting.', 401, cors);

		// Banned users (by IP or display name) can't post comments.
		const banned = await bannedResponse(env, base, request, user, cors);
		if (banned) return banned;

		// Every commenter needs a display name so we never expose an email in a
		// thread. The client forces this at sign-up; re-check so it can't be bypassed.
		if (!displayNameOf(user)) {
			return textResponse('Please choose a display name before commenting.', 403, cors);
		}

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const text = (body && typeof body.body === 'string' ? body.body : '').trim();
		if (!text) return textResponse('Write something before posting.', 400, cors);
		if (text.length > MAX_COMMENT_LENGTH) {
			return textResponse(`Comments are limited to ${MAX_COMMENT_LENGTH} characters.`, 400, cors);
		}

		// Optional: the comment being replied to. Empty/missing means a top-level
		// comment. We validate it (below) belongs to this lesson before inserting.
		const parentId = (body && body.parentId ? String(body.parentId) : '').trim();

		// Moderation: block the entire comment if it contains profanity. Done
		// server-side so it can't be bypassed by a crafted client request.
		if (profanityFilter.checkProfanity(text).containsProfanity) {
			return textResponse('This comment contains language that isn’t allowed. Please revise it and try again.', 422, cors);
		}

		// The lesson must exist; the FK would reject an orphan comment anyway, but
		// checking first lets us return a clear 404 instead of a generic store error.
		let lessonRes;
		try {
			lessonRes = await fetch(`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(lessonId)}&select=id,author_id,title&limit=1`, {
				headers: supabaseHeaders(env),
			});
		} catch (e) {
			return textResponse('Could not reach the comment store.', 502, cors);
		}
		const lessonRows = lessonRes.ok ? await lessonRes.json().catch(() => []) : [];
		if (!Array.isArray(lessonRows) || lessonRows.length === 0) {
			return textResponse('Lesson not found.', 404, cors);
		}
		const lesson = lessonRows[0];

		// If this is a reply, the parent must exist and belong to the same lesson.
		// We grab its author_id so we can notify that person once the reply lands.
		let parentComment = null;
		if (parentId) {
			let parentRes;
			try {
				parentRes = await fetch(
					`${base}/rest/v1/comments?id=eq.${encodeURIComponent(parentId)}&lesson_id=eq.${encodeURIComponent(lessonId)}&select=id,author_id&limit=1`,
					{ headers: supabaseHeaders(env) },
				);
			} catch (e) {
				return textResponse('Could not reach the comment store.', 502, cors);
			}
			const parentRows = parentRes.ok ? await parentRes.json().catch(() => []) : [];
			if (!Array.isArray(parentRows) || parentRows.length === 0) {
				return textResponse('The comment you’re replying to no longer exists.', 404, cors);
			}
			parentComment = parentRows[0];
		}

		const insert = {
			lesson_id: lessonId,
			parent_id: parentId || null,
			author_id: user.id,
			author: authorFromUser(user),
			body: text,
			// Recorded so an admin can later ban the address from this comment.
			author_ip: clientIp(request) || null,
		};

		let res;
		try {
			res = await fetch(`${base}/rest/v1/comments?select=id,parent_id,author,body,created_at`, {
				method: 'POST',
				headers: {
					...supabaseHeaders(env),
					'Content-Type': 'application/json',
					Prefer: 'return=representation',
				},
				body: JSON.stringify(insert),
			});
		} catch (e) {
			return textResponse('Could not reach the comment store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not post the comment.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Could not post the comment.', 502, cors);
		}
		const comment = rowToComment(rows[0]);

		// A reply notifies two people: the parent comment's author ("replied to your
		// comment") and the lesson's author ("replied to a comment on your lesson").
		// We dedupe by recipient id with a Map, so when the lesson author is also the
		// parent comment's author they get a single notification (keeping the more
		// specific "your comment" wording), and we never notify the replier themselves.
		// Notification failures are swallowed so they can't fail the reply.
		if (parentComment) {
			const replier = authorFromUser(user);
			const link = `/hub/${encodeURIComponent(lessonId)}`;
			const byRecipient = new Map();
			if (parentComment.author_id && parentComment.author_id !== user.id) {
				byRecipient.set(parentComment.author_id, `${replier} replied to your comment`);
			}
			if (lesson.author_id && lesson.author_id !== user.id && !byRecipient.has(lesson.author_id)) {
				byRecipient.set(lesson.author_id, `${replier} replied to a comment on your lesson`);
			}
			await Promise.all(
				[...byRecipient.entries()].map(([userId, title]) =>
					createNotification(env, base, { userId, type: 'comment', title, body: text, link }).catch(() => {}),
				),
			);
		}

		return jsonResponse({ comment }, 201, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}
