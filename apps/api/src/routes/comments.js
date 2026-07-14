// Comment endpoints for a single published lesson, backed by Supabase Postgres.
// POST is moderated through glin-profanity; replies notify the parent comment's
// author and the lesson's author. An author may later edit their own comment
// (PATCH), which re-runs the same validation.
//
// Comment bodies are rich text: HTML authored in the browser with mui-tiptap. The
// stored value is whatever `sanitizeRichText` allows through and nothing else —
// see lib/richtext.js, which is the sole authority on that, and the reason a
// hand-crafted POST can't smuggle in a <script> or an <img>. Everything that isn't
// the comment thread itself (profanity, length, notifications, the Atom feed) works
// from the flattened plain text, not the markup.

import { supabaseHeaders, verifySupabaseUser } from '../lib/supabase.js';
import { authorFromUser, bearerToken, clientIp, displayNameOf } from '../lib/auth.js';
import { bannedResponse } from '../lib/bans.js';
import { profanityFilter } from '../lib/profanity.js';
import { textResponse, jsonResponse } from '../lib/http.js';
import { fetchRatingStats, upsertRating } from '../lib/ratings.js';
import { richTextToPlain, sanitizeRichText } from '../lib/richtext.js';
import { createNotification } from './notifications.js';

// The longest comment we accept, measured in the text the user actually wrote —
// not in markup, so wrapping a sentence in <strong> can't cost them their budget.
// Comments are short discussion, not documents.
const MAX_COMMENT_LENGTH = 2000;

// A separate ceiling on the raw HTML, checked before we bother parsing it. Markup
// is maybe 5x the text at its worst (every word individually styled), so this is
// slack enough for any real comment while refusing a multi-megabyte markup bomb.
const MAX_COMMENT_HTML = 20000;

// The columns that make up a comment. `edited_at` is null until the author edits it.
const COMMENT_COLUMNS = 'id,parent_id,author_id,author,body,created_at,edited_at';

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
		// their /users/:id profile when present, and uses it to decide whether to
		// offer an Edit button (you may only edit your own comment).
		authorId: row.author_id || null,
		author: row.author,
		// Sanitized rich-text HTML (or bare text, for comments predating rich text).
		body: row.body,
		createdAt: row.created_at,
		// When the author last edited it, or null if never. The UI shows an "edited"
		// marker when this is set.
		editedAt: row.edited_at || null,
	};
}

/**
 * Validate and sanitize a submitted comment body, shared by POST and PATCH so an
 * edit can't slip past a rule the original post had to satisfy.
 *
 * Order matters: sanitize first, then judge the *result*. Checking length or
 * profanity against the raw submission would let markup pad the length, and would
 * make the profanity filter scan tag names and URLs instead of prose.
 *
 * @returns {Promise<{html: string, text: string, error: null} | {error: Response}>}
 */
async function readCommentBody(body, cors) {
	const raw = body && typeof body.body === 'string' ? body.body : '';
	if (raw.length > MAX_COMMENT_HTML) {
		return { error: textResponse(`Comments are limited to ${MAX_COMMENT_LENGTH} characters.`, 400, cors) };
	}

	const html = await sanitizeRichText(raw);
	const text = richTextToPlain(html);

	// Empty *after* sanitizing: a comment of nothing but an <img> is a comment of
	// nothing at all.
	if (!text) {
		return { error: textResponse('Write something before posting.', 400, cors) };
	}
	if (text.length > MAX_COMMENT_LENGTH) {
		return { error: textResponse(`Comments are limited to ${MAX_COMMENT_LENGTH} characters.`, 400, cors) };
	}

	// Moderation: block the entire comment if it contains profanity. Done
	// server-side so it can't be bypassed by a crafted client request.
	if (profanityFilter.checkProfanity(text).containsProfanity) {
		return {
			error: textResponse('This comment contains language that isn’t allowed. Please revise it and try again.', 422, cors),
		};
	}

	return { html, text, error: null };
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
 *
 * A POST may also carry `rating` (1–5) to rate the lesson alongside the comment.
 * The rating is upserted into the `ratings` table keyed by (lesson, user), so a
 * user has a single, updatable rating per lesson. When a rating is included the
 * response carries the lesson's new `{ average, count }` so the page can update
 * its displayed average without re-fetching; otherwise `rating` is null.
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
		const query = `lesson_id=eq.${encodeURIComponent(lessonId)}&select=${COMMENT_COLUMNS}&order=created_at.asc`;
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
		// Sanitize the rich-text body, then check the resulting *text* for emptiness,
		// length and profanity (see readCommentBody).
		const parsed = await readCommentBody(body, cors);
		if (parsed.error) return parsed.error;
		const { html, text } = parsed;

		// Optional: the comment being replied to. Empty/missing means a top-level
		// comment. We validate it (below) belongs to this lesson before inserting.
		const parentId = (body && body.parentId ? String(body.parentId) : '').trim();

		// Optional: a 1–5 star rating for the lesson, submitted alongside the
		// comment. Absent/null means "comment without a rating". Anything present
		// must be a whole number in range — reject rather than silently clamp so a
		// buggy client is caught.
		let stars = null;
		if (body && body.rating != null) {
			const n = Number(body.rating);
			if (!Number.isInteger(n) || n < 1 || n > 5) {
				return textResponse('A rating must be a whole number of stars from 1 to 5.', 400, cors);
			}
			stars = n;
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
			// The sanitized HTML — never the raw submission.
			body: html,
			// Recorded so an admin can later ban the address from this comment.
			author_ip: clientIp(request) || null,
		};

		let res;
		try {
			res = await fetch(`${base}/rest/v1/comments?select=${COMMENT_COLUMNS}`, {
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
		// The notification carries the flattened `text`, not the HTML: the bell renders
		// its body as plain text, so markup would show up there as literal tags.
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

		// If a rating rode along with the comment, upsert it (one per user per
		// lesson) and return the lesson's fresh average so the page can update the
		// stars it shows without re-fetching. A rating write that fails shouldn't
		// fail the comment that already landed, so we just report no rating back.
		let rating = null;
		if (stars != null) {
			const ok = await upsertRating(env, base, lessonId, user.id, stars);
			if (ok) rating = await fetchRatingStats(env, base, lessonId);
		}

		return jsonResponse({ comment, rating }, 201, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}

/**
 * Edit one comment's body.
 *
 *   PATCH /lessons/:id/comments/:commentId   Bearer  { body }  -> { comment: Comment }
 *
 * Authors only, and only their own comment: ownership is decided by comparing the
 * stored `author_id` against the verified JWT's user id, never by anything the
 * request claims. Moderators deliberately have no edit power here — they can delete
 * a comment (see routes/moderation.js), but letting them rewrite one would let them
 * put words in someone else's mouth under that person's name.
 *
 * The new body goes through exactly the same sanitize/length/profanity pipeline as a
 * fresh post (`readCommentBody`), so editing is not a way to launder content past the
 * rules that applied when posting. A successful edit stamps `edited_at`, which the UI
 * surfaces as an "edited" marker — an edit is visible, not silent.
 *
 * Only the body changes: the author, the parent, the timestamp and any rating that
 * rode along with the original post are all left alone.
 */
export async function handleCommentEdit(request, env, lessonId, commentId, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (!lessonId || !commentId) return textResponse('Missing comment id.', 400, cors);
	if (request.method !== 'PATCH') return textResponse('Method not allowed.', 405, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');

	const user = await verifySupabaseUser(env, bearerToken(request));
	if (!user) return textResponse('Please sign in before editing.', 401, cors);

	// A banned user can't edit their way back into the conversation.
	const banned = await bannedResponse(env, base, request, user, cors);
	if (banned) return banned;

	let body;
	try {
		body = await request.json();
	} catch (e) {
		return textResponse('Invalid JSON body', 400, cors);
	}

	const parsed = await readCommentBody(body, cors);
	if (parsed.error) return parsed.error;
	const { html } = parsed;

	// Load the comment first so we can distinguish "no such comment" (404) from
	// "not yours" (403), and so ownership is checked against the stored row.
	let existingRes;
	try {
		existingRes = await fetch(
			`${base}/rest/v1/comments?id=eq.${encodeURIComponent(commentId)}&lesson_id=eq.${encodeURIComponent(lessonId)}&select=id,author_id&limit=1`,
			{ headers: supabaseHeaders(env) },
		);
	} catch (e) {
		return textResponse('Could not reach the comment store.', 502, cors);
	}
	const existingRows = existingRes.ok ? await existingRes.json().catch(() => []) : [];
	if (!Array.isArray(existingRows) || existingRows.length === 0) {
		return textResponse('That comment no longer exists.', 404, cors);
	}
	if (existingRows[0].author_id !== user.id) {
		return textResponse('You can only edit your own comments.', 403, cors);
	}

	let res;
	try {
		res = await fetch(`${base}/rest/v1/comments?id=eq.${encodeURIComponent(commentId)}&select=${COMMENT_COLUMNS}`, {
			method: 'PATCH',
			headers: {
				...supabaseHeaders(env),
				'Content-Type': 'application/json',
				Prefer: 'return=representation',
			},
			body: JSON.stringify({ body: html, edited_at: new Date().toISOString() }),
		});
	} catch (e) {
		return textResponse('Could not reach the comment store.', 502, cors);
	}
	if (!res.ok) return textResponse('Could not save your edit.', 502, cors);
	const rows = await res.json().catch(() => []);
	if (!Array.isArray(rows) || rows.length === 0) {
		return textResponse('Could not save your edit.', 502, cors);
	}

	return jsonResponse({ comment: rowToComment(rows[0]) }, 200, cors);
}
