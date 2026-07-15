// Lesson helpers shared by the lessons, moderation and profile routes: the
// row→summary mapper, the trusted-collaborator check, and the full
// (author-agnostic) delete used by admins.

import { supabaseHeaders } from './supabase.js';
import { deleteLessonGit } from './lessonGit.js';

/**
 * The emails on a lesson's trusted-collaborator list, lowercased.
 *
 * The list lives on the lesson's own document (`doc.trustedCollaborators`, each
 * entry `{ email, name? }`) and is managed by the author in the collaboration
 * dialog. Trusted collaborators are auto-admitted to a live session — and, per
 * below, may merge a fork back into the lesson.
 */
export function trustedEmails(doc) {
	const list = doc && Array.isArray(doc.trustedCollaborators) ? doc.trustedCollaborators : [];
	return new Set(list.map((t) => (t && typeof t.email === 'string' ? t.email.trim().toLowerCase() : '')).filter(Boolean));
}

/**
 * Whether a verified user is a trusted collaborator on a lesson — i.e. someone
 * the author invited, who may therefore merge their fork back into it.
 *
 * This is the *only* way a non-author gets write access to a lesson, and it is
 * deliberately narrow: it lets them update the lesson's title, document and
 * history. It does not let them publish/unpublish it, delete it, or change the
 * trusted list itself (the routes strip those — see routes/lessons.js), because
 * a trusted collaborator must not be able to widen their own privileges or hand
 * them to someone else.
 *
 * `row` must have been selected with its `doc`, since the list lives inside it.
 */
export function isTrustedCollaborator(row, user) {
	const email = (user && typeof user.email === 'string' ? user.email : '').trim().toLowerCase();
	if (!email) return false;
	return trustedEmails(row && row.doc).has(email);
}

/**
 * Fetch the row behind a lesson id, for the paths that must decide who the caller
 * is before letting them through.
 *
 * `withDoc` pulls the lesson's document too, which is needed to answer
 * isTrustedCollaborator (the trusted list lives inside it). It's off by default
 * because the doc is the whole lesson — the public read paths only need
 * `shadowbanned` and shouldn't be dragging a lesson's entire content out of the
 * database to get it.
 *
 * Returns null when the lesson doesn't exist or the store can't be reached —
 * callers treat both as "no".
 */
export async function fetchLessonRow(env, base, lessonId, { withDoc = false } = {}) {
	const columns = withDoc ? 'id,author_id,published,shadowbanned,doc' : 'id,author_id,published,shadowbanned';
	const query = `id=eq.${encodeURIComponent(lessonId)}&select=${columns}&limit=1`;
	let res;
	try {
		res = await fetch(`${base}/rest/v1/lessons?${query}`, { headers: supabaseHeaders(env) });
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	const rows = await res.json().catch(() => []);
	return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Map a Supabase `lessons` row to the camelCase summary the frontend expects.
 * `withDoc` includes the full editor document (used by the single-lesson fetch).
 */
export function rowToLesson(row, withDoc, includeMod) {
	const lesson = {
		id: row.id,
		// The author's Supabase user id — the frontend compares it with the
		// signed-in user to decide whether to offer an "Edit" action. (The author
		// display name lives separately in `author`.)
		authorId: row.author_id,
		title: row.title,
		author: row.author,
		sectionCount: row.section_count ?? 0,
		// Whether the lesson is shared on the public hub. `false` is a draft, backed
		// up to the database but visible only to its author. Defaults to true so a
		// row from a database that predates the `published` column reads as published.
		published: row.published ?? true,
		// Whether a moderator has hidden the lesson from the public hub. Defaults to
		// false so rows predating the column read as visible.
		shadowbanned: row.shadowbanned ?? false,
		// The lesson this one was forked from, or null. A fork keeps this pointer home
		// so the editor can offer to pull the original's later changes in, merging the
		// two histories against the commit they diverged from (see web/src/lib/git/).
		forkedFrom: row.forked_from ?? null,
		createdAt: row.created_at,
	};
	if (withDoc) lesson.doc = row.doc;
	// The author's IP is sensitive: only attach it for mod/admin reads (for the
	// admin "ban by IP" action), never in public or author-facing responses.
	if (includeMod) lesson.authorIp = row.author_ip ?? null;
	return lesson;
}

/**
 * Permanently delete a lesson and its comments, regardless of author. Used by the
 * admin "delete fully" action and by approving a moderator's deletion request.
 * Mirrors the author DELETE path's comments-first ordering so it works even on a
 * database whose comments FK doesn't cascade. Returns true if a lesson row was
 * actually removed.
 */
export async function fullyDeleteLesson(env, base, lessonId) {
	try {
		await fetch(`${base}/rest/v1/comments?lesson_id=eq.${encodeURIComponent(lessonId)}`, {
			method: 'DELETE',
			headers: supabaseHeaders(env),
		});
	} catch (e) {
		return false;
	}
	let res;
	try {
		res = await fetch(`${base}/rest/v1/lessons?id=eq.${encodeURIComponent(lessonId)}&select=id`, {
			method: 'DELETE',
			headers: { ...supabaseHeaders(env), Prefer: 'return=representation' },
		});
	} catch (e) {
		return false;
	}
	if (!res.ok) return false;
	const rows = await res.json().catch(() => []);
	const deleted = Array.isArray(rows) && rows.length > 0;
	// Drop the lesson's stored version history too, so its packfile doesn't outlive
	// it in the bucket. Best-effort — the row is already gone either way.
	if (deleted) await deleteLessonGit(env, lessonId);
	return deleted;
}
