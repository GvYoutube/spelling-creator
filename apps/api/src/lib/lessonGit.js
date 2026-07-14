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
// The routes that read and write them are in routes/git.js. This module holds
// only the key layout and the delete, so the lesson-delete paths (routes/lessons.js
// and lib/lesson.js) can clean a lesson's history up without a route importing a
// route.

// A lesson id is a UUID — pinned down because it's interpolated into an R2 key.
export const LESSON_ID_RE = /^[0-9a-fA-F-]{36}$/;

export const packKey = (lessonId) => `git/${lessonId}/pack`;
export const refsKey = (lessonId) => `git/${lessonId}/refs.json`;

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
