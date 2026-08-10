// Where a lesson's packed version history lives in R2, and how to remove it.
//
// The editor keeps each lesson in a real git repository in the browser (one file
// per content block — see web/src/lib/git/). For someone else to fork a lesson,
// that repository travels as a packfile, which the author uploads and we store
// here. Two objects per lesson:
//
//   git/<lessonId>/pack        the packfile bytes
//   git/<lessonId>/refs.json   { head, size, updatedAt }
//
// A pull request — someone proposing changes to a lesson they don't own — is a
// packfile too, snapshotted when the request was opened, under its own key:
//
//   git/pulls/<pullRequestId>/pack
//
// It needs no refs.json: a pull request's tip is fixed at the moment it is
// opened and recorded on its database row, so there is nothing to advertise
// separately. (The head still rides along in the object's customMetadata, so a
// reader gets bytes and tip from one object, as for a lesson.)
//
// The routes that read and write them are in routes/git.js and routes/pulls.js.
// This module holds only the key layout and the deletes, so the lesson-delete
// paths (routes/lessons.js and lib/lesson.js) can clean a lesson's history up
// without a route importing a route.

import { supabaseHeaders } from './supabase.js';

// A lesson id is a UUID — pinned down because it's interpolated into an R2 key.
export const LESSON_ID_RE = /^[0-9a-fA-F-]{36}$/;

// A commit oid is a 40-char lowercase hex SHA-1.
export const OID_RE = /^[0-9a-f]{40}$/;

// Cap one repository's history. Packs hold only JSON (images are referenced by
// hash and live in the images bucket, not in the repo), so even a long-lived
// lesson with hundreds of commits stays well under this. The same ceiling
// applies to a pull request's pack, which is one fork's history.
export const MAX_PACK_BYTES = 10 * 1024 * 1024;

// Every packfile starts with the four bytes "PACK". Checked before anything is
// stored, so an authenticated caller can't use the bucket as general-purpose
// storage by uploading arbitrary bytes to a pack key.
const PACK_MAGIC = [0x50, 0x41, 0x43, 0x4b];

/** Whether these bytes even claim to be a packfile. */
export const isPackfile = (bytes) => PACK_MAGIC.every((b, i) => bytes[i] === b);

export const packKey = (lessonId) => `git/${lessonId}/pack`;
export const refsKey = (lessonId) => `git/${lessonId}/refs.json`;
export const pullPackKey = (pullId) => `git/pulls/${pullId}/pack`;

/**
 * Delete a lesson's stored history. Called when the lesson itself is deleted, so
 * an orphaned pack can't linger in the bucket. Best-effort: a failure here must
 * not block the lesson delete, which is the part the user actually asked for.
 */
export async function deleteLessonGit(env, lessonId) {
	if (!env.LESSON_GIT || !LESSON_ID_RE.test(lessonId)) return;
	try {
		await env.LESSON_GIT.delete([packKey(lessonId), refsKey(lessonId)]);
	} catch (e) {
		// The lesson row is already gone; a stray pack is harmless.
	}
}

/**
 * Delete one pull request's stored pack. Called when a request is withdrawn or
 * closed, and when its lesson is deleted. Best-effort for the same reason as
 * above: the row is the record, the pack is only its payload.
 */
export async function deletePullGit(env, pullId) {
	if (!env.LESSON_GIT || !LESSON_ID_RE.test(pullId)) return;
	try {
		await env.LESSON_GIT.delete(pullPackKey(pullId));
	} catch (e) {
		// Nothing left to review either way.
	}
}

/**
 * Delete the packs of every pull request against a lesson.
 *
 * The rows themselves go with the lesson (their FK cascades), but R2 knows
 * nothing about that, so the packs have to be swept explicitly *before* the
 * lesson row disappears and takes the ids we'd need with it. Best-effort
 * throughout: a lesson delete must never fail because a bucket was unreachable.
 */
export async function deleteLessonPullGit(env, base, lessonId) {
	if (!env.LESSON_GIT || !LESSON_ID_RE.test(lessonId)) return;
	let res;
	try {
		res = await fetch(`${base}/rest/v1/lesson_pull_requests?lesson_id=eq.${encodeURIComponent(lessonId)}&select=id`, {
			headers: supabaseHeaders(env),
		});
	} catch (e) {
		return;
	}
	if (!res.ok) return;
	const rows = await res.json().catch(() => []);
	if (!Array.isArray(rows) || rows.length === 0) return;
	try {
		await env.LESSON_GIT.delete(rows.filter((r) => LESSON_ID_RE.test(r.id)).map((r) => pullPackKey(r.id)));
	} catch (e) {
		// Stray packs are harmless; the proposals they belonged to are gone.
	}
}
