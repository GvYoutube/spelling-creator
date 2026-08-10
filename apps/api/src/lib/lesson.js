// Lesson helpers shared by the lessons, moderation and profile routes: the
// row→summary mapper, the trusted-collaborator check, and the full
// (author-agnostic) delete used by admins.

import { supabaseHeaders } from './supabase.js';
import { isModeratorRole, verifyUserAndRole } from './auth.js';
import { deleteLessonGit, deleteLessonPullGit } from './lessonGit.js';

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
	// `forked_from` rides along because it is a permission input, not just display:
	// opening a proposal against your own lesson is allowed only from a fork *of
	// that lesson* (see openPull in routes/pulls.js).
	const columns = withDoc ? 'id,author_id,published,shadowbanned,forked_from,doc' : 'id,author_id,published,shadowbanned,forked_from';
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
 * Whether the caller behind this request may *see* a lesson at all.
 *
 * A published, non-shadowbanned lesson is public, and that's the common case —
 * it answers without verifying a token. Anything else (a private draft, or a
 * lesson a moderator has shadowbanned) is visible only to its author, a trusted
 * collaborator, and moderators/admins. This is the single rule behind
 * GET /lessons/:id, a lesson's comments, its stored history, and its pull
 * requests, so that "can I read this?" has exactly one answer everywhere.
 *
 * `row` needs only `id`, `author_id`, `published` and `shadowbanned`; if it also
 * carries `doc` the trusted-collaborator check uses it, and if not, the doc is
 * fetched only on the uncommon path that actually needs it.
 */
export async function canReadLesson(env, base, request, row) {
	if (!row) return false;
	if (row.published && !row.shadowbanned) return true;

	const { user, role } = await verifyUserAndRole(env, base, request);
	if (user && user.id === row.author_id) return true;
	if (isModeratorRole(role)) return true;
	if (!user) return false;

	const full = row.doc !== undefined ? row : await fetchLessonRow(env, base, row.id, { withDoc: true });
	return Boolean(full && isTrustedCollaborator(full, user));
}

/**
 * A lesson document with its trusted-collaborator list removed.
 *
 * That list holds collaborator **email addresses**, and it lives inside the
 * lesson's own document — which is otherwise entirely public: `GET /lessons/:id`
 * serves it to anyone, the server renderer bakes it into the HTML, and forking
 * copies it. So the emails are taken out on the way out, and put back only for
 * the two kinds of caller the list is actually for (see `rowToLesson`).
 *
 * The same rule is applied wherever else the document travels: it is excluded
 * from the git tree, so it can't ride along in a packfile someone clones, and
 * from the live-collaboration Y.Doc, so an admitted guest never receives it. See
 * `preserveLocalFields` in `@spelling-creator/core/git/doc`.
 */
export function stripCollaborators(doc) {
	if (!doc || typeof doc !== 'object' || doc.trustedCollaborators === undefined) return doc;
	const out = { ...doc };
	delete out.trustedCollaborators;
	return out;
}

/**
 * Map a Supabase `lessons` row to the camelCase summary the frontend expects.
 *
 * @param {object}  row
 * @param {object}  [opts]
 * @param {boolean} [opts.withDoc]  Include the full editor document (the
 *        single-lesson fetch; the listings deliberately don't).
 * @param {boolean} [opts.includeMod]  Include the moderator-only fields (the
 *        author's IP, for the admin "ban by IP" action).
 * @param {boolean} [opts.includeCollaborators]  Leave the trusted-collaborator
 *        list on the document. Off by default — it holds email addresses, so it
 *        is only ever attached for the lesson's author (who manages it) and the
 *        collaborators on it (who need it to auto-admit each other to a live
 *        session). Everyone else, including moderators, gets it stripped.
 */
export function rowToLesson(row, { withDoc = false, includeMod = false, includeCollaborators = false } = {}) {
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
	if (withDoc) lesson.doc = includeCollaborators ? row.doc : stripCollaborators(row.doc);
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
	// Sweep the packs of any pull requests against this lesson first: their rows
	// go with the lesson (the FK cascades), taking with them the ids we need to
	// find the packs, so this has to happen while the lesson is still there.
	await deleteLessonPullGit(env, base, lessonId);
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
