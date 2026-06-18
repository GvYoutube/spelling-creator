// Lesson helpers shared by the lessons, moderation and profile routes: the
// row→summary mapper and the full (author-agnostic) delete used by admins.

import { supabaseHeaders } from './supabase.js';

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
	return Array.isArray(rows) && rows.length > 0;
}
