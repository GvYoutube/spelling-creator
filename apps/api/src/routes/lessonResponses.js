// A learner's private answers from interactive mode (see the web app's
// InteractiveLesson): the lesson is walked one step at a time and each question
// is typed into a text field, then the completed set is saved to the learner's
// own account.
//
//   GET    /lessons/:id/responses      Bearer -> { responses: LessonResponse[] }  (the caller's own, newest first)
//   POST   /lessons/:id/responses      Bearer -> { response: LessonResponse }
//   DELETE /lessons/:id/responses/:rid Bearer -> { ok: true }                     (the caller's own only)
//
// PRIVACY IS THE POINT OF THIS FILE. Every query below is filtered on
// `user_id=eq.<verified caller>` — not as belt-and-braces on top of an ownership
// check, but as the only way a row is ever addressed. There is deliberately no
// endpoint here that returns another user's answers: not for the lesson's author,
// not for a moderator, not for an admin. A lesson author can see that their
// lesson exists and who commented on it; they cannot see who worked through it or
// what they wrote. Anything that would change that belongs in a conversation
// about consent first and a pull request second.
//
// Because nobody but the author of an answer ever reads it, answers are NOT run
// through the profanity filter the way comments are — there is no audience to
// protect. They are still normalised and length-capped below, so what lands in
// `answers` jsonb is a known shape and a bounded size.

import { supabaseHeaders, verifySupabaseUser } from '../lib/supabase.js';
import { bearerToken, isModeratorRole, verifyUserAndRole } from '../lib/auth.js';
import { fetchLessonRow, isTrustedCollaborator } from '../lib/lesson.js';
import { textResponse, jsonResponse } from '../lib/http.js';
import { MAX_RESPONSES, MAX_RESPONSE_LENGTH, MAX_STORED_RESPONSES } from '@spelling-creator/core/interactive';
import { QUESTION_TYPES } from '@spelling-creator/core/questions';

// The columns that make up a saved run-through. `user_id` is never returned: the
// caller is the only user it can ever be.
const RESPONSE_COLUMNS = 'id,lesson_id,answers,completed_at';

// Per-field caps applied when normalising a submission. The answer itself is
// capped at MAX_RESPONSE_LENGTH (shared with the browser via core/interactive.js);
// the rest are snapshots of the lesson, which the client copies from the document
// rather than typing, so these only need to be generous enough for any real lesson.
const MAX_ID_LENGTH = 100;
const MAX_SECTION_NAME_LENGTH = 300;
const MAX_PROMPT_LENGTH = 2000;

const str = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

/**
 * Map a Supabase `lesson_responses` row to the camelCase shape the frontend expects.
 */
function rowToResponse(row) {
	return {
		id: row.id,
		lessonId: row.lesson_id,
		// One entry per question the lesson asked, in the order it asked them. Each
		// carries a snapshot of the prompt it answered, so a saved run-through stays
		// readable after the lesson is edited, re-ordered, or has that question removed.
		answers: Array.isArray(row.answers) ? row.answers : [],
		completedAt: row.completed_at,
	};
}

/**
 * Validate and normalise a submitted answer set. Nothing from the request body is
 * stored as-is: every field is coerced to a string of a known maximum length and
 * unknown fields are dropped, so `answers` jsonb can only ever hold the shape this
 * function produces.
 *
 * @returns {{answers: object[], error: null} | {error: Response}}
 */
function readAnswers(body, cors) {
	const raw = body && body.answers;
	if (!Array.isArray(raw)) {
		return { error: textResponse('Answers must be a list.', 400, cors) };
	}
	if (raw.length > MAX_RESPONSES) {
		return { error: textResponse(`A lesson run-through can hold at most ${MAX_RESPONSES} answers.`, 400, cors) };
	}

	const answers = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') {
			return { error: textResponse('Each answer must be an object.', 400, cors) };
		}
		if (typeof entry.answer !== 'string') {
			return { error: textResponse('Each answer must be text.', 400, cors) };
		}
		if (entry.answer.length > MAX_RESPONSE_LENGTH) {
			return { error: textResponse(`Answers are limited to ${MAX_RESPONSE_LENGTH} characters.`, 400, cors) };
		}
		answers.push({
			blockId: str(entry.blockId, MAX_ID_LENGTH),
			sectionId: str(entry.sectionId, MAX_ID_LENGTH),
			sectionName: str(entry.sectionName, MAX_SECTION_NAME_LENGTH),
			// An unrecognised type falls back to 'open' rather than being rejected — the
			// type is only used to label the answer when it's read back.
			questionType: Object.hasOwn(QUESTION_TYPES, entry.questionType) ? entry.questionType : 'open',
			prompt: str(entry.prompt, MAX_PROMPT_LENGTH),
			answer: entry.answer,
		});
	}

	return { answers, error: null };
}

/**
 * Whether this caller is allowed to work through this lesson at all. Mirrors the
 * visibility rule GET /lessons/:id enforces: a published, non-shadowbanned lesson
 * is open to any signed-in user; a draft or a hidden lesson only to its author, a
 * trusted collaborator, or a moderator/admin. Without this, a stranger who guessed
 * a draft's id could save answers against a lesson they can't read — harmless in
 * itself, but it would leave rows pointing at a lesson they were never shown.
 */
async function canPlayLesson(env, base, request, lessonId) {
	const row = await fetchLessonRow(env, base, lessonId, { withDoc: true });
	if (!row) return { found: false, allowed: false };
	if (row.published && !row.shadowbanned) return { found: true, allowed: true };

	const { user, role } = await verifyUserAndRole(env, base, request);
	const isOwner = user && user.id === row.author_id;
	const isTrusted = !isOwner && user && isTrustedCollaborator(row, user);
	return { found: true, allowed: Boolean(isOwner || isTrusted || isModeratorRole(role)) };
}

/**
 * List, save and count a signed-in user's own run-throughs of one lesson.
 * See the privacy note at the top of this file.
 */
export async function handleLessonResponses(request, env, lessonId, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (!lessonId) return textResponse('Missing lesson id.', 400, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');

	// GET — the caller's own saved run-throughs of this lesson, newest first.
	if (request.method === 'GET') {
		const user = await verifySupabaseUser(env, bearerToken(request));
		if (!user) return textResponse('Please sign in to see your answers.', 401, cors);

		const query = `user_id=eq.${encodeURIComponent(user.id)}&lesson_id=eq.${encodeURIComponent(
			lessonId,
		)}&select=${RESPONSE_COLUMNS}&order=completed_at.desc`;
		let res;
		try {
			res = await fetch(`${base}/rest/v1/lesson_responses?${query}`, { headers: supabaseHeaders(env) });
		} catch (e) {
			return textResponse('Could not reach the answer store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not load your answers.', 502, cors);
		const rows = await res.json().catch(() => []);
		return jsonResponse({ responses: (Array.isArray(rows) ? rows : []).map(rowToResponse) }, 200, cors);
	}

	// POST — save a completed run-through. Sent once, when the learner finishes;
	// nothing is stored while they're still typing.
	if (request.method === 'POST') {
		const user = await verifySupabaseUser(env, bearerToken(request));
		if (!user) return textResponse('Please sign in to save your answers.', 401, cors);

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return textResponse('Invalid JSON body', 400, cors);
		}
		const parsed = readAnswers(body, cors);
		if (parsed.error) return parsed.error;

		// The lesson must exist and be one this caller could actually have read.
		const { found, allowed } = await canPlayLesson(env, base, request, lessonId);
		if (!found || !allowed) return textResponse('Lesson not found.', 404, cors);

		// Cap how many run-throughs of one lesson a user accumulates. Rejected rather
		// than silently pruned: these are the user's own answers, and quietly deleting
		// the oldest to make room for the newest is not ours to decide. Mirrors how
		// the draft cap in routes/lessons.js behaves.
		let countRes;
		try {
			countRes = await fetch(
				`${base}/rest/v1/lesson_responses?user_id=eq.${encodeURIComponent(user.id)}&lesson_id=eq.${encodeURIComponent(lessonId)}&select=id`,
				{ headers: supabaseHeaders(env) },
			);
		} catch (e) {
			return textResponse('Could not reach the answer store.', 502, cors);
		}
		if (!countRes.ok) return textResponse('Could not save your answers.', 502, cors);
		const existing = await countRes.json().catch(() => null);
		if (!Array.isArray(existing)) return textResponse('Could not save your answers.', 502, cors);
		if (existing.length >= MAX_STORED_RESPONSES) {
			return textResponse(
				`You can keep at most ${MAX_STORED_RESPONSES} saved run-throughs of one lesson. Delete an older one to save this.`,
				409,
				cors,
			);
		}

		let res;
		try {
			res = await fetch(`${base}/rest/v1/lesson_responses?select=${RESPONSE_COLUMNS}`, {
				method: 'POST',
				headers: {
					...supabaseHeaders(env),
					'Content-Type': 'application/json',
					Prefer: 'return=representation',
				},
				body: JSON.stringify({
					lesson_id: lessonId,
					// Taken from the verified token, never from the body — the whole privacy
					// model rests on this one line.
					user_id: user.id,
					answers: parsed.answers,
				}),
			});
		} catch (e) {
			return textResponse('Could not reach the answer store.', 502, cors);
		}
		if (!res.ok) return textResponse('Could not save your answers.', 502, cors);
		const rows = await res.json().catch(() => []);
		if (!Array.isArray(rows) || rows.length === 0) {
			return textResponse('Could not save your answers.', 502, cors);
		}
		return jsonResponse({ response: rowToResponse(rows[0]) }, 201, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}

/**
 * Delete one of the caller's own saved run-throughs.
 *
 *   DELETE /lessons/:id/responses/:responseId   Bearer -> { ok: true }
 *
 * Filtered on the verified user's id as well as the row id, so a request for
 * someone else's row matches nothing and comes back 404 — it never even reveals
 * that the row exists.
 */
export async function handleLessonResponseDelete(request, env, lessonId, responseId, cors) {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (!lessonId || !responseId) return textResponse('Missing answer id.', 400, cors);
	if (request.method !== 'DELETE') return textResponse('Method not allowed.', 405, cors);

	const base = env.SUPABASE_URL.replace(/\/$/, '');

	const user = await verifySupabaseUser(env, bearerToken(request));
	if (!user) return textResponse('Please sign in to delete your answers.', 401, cors);

	let res;
	try {
		res = await fetch(
			`${base}/rest/v1/lesson_responses?id=eq.${encodeURIComponent(responseId)}&lesson_id=eq.${encodeURIComponent(
				lessonId,
			)}&user_id=eq.${encodeURIComponent(user.id)}&select=id`,
			{
				method: 'DELETE',
				headers: { ...supabaseHeaders(env), Prefer: 'return=representation' },
			},
		);
	} catch (e) {
		return textResponse('Could not reach the answer store.', 502, cors);
	}
	if (!res.ok) return textResponse('Could not delete your answers.', 502, cors);
	const rows = await res.json().catch(() => []);
	if (!Array.isArray(rows) || rows.length === 0) {
		return textResponse('Those answers no longer exist.', 404, cors);
	}

	return jsonResponse({ ok: true }, 200, cors);
}
