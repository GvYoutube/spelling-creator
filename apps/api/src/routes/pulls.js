// Pull requests: proposing changes to a lesson you don't own.
//
// Anyone may fork a published lesson, but nobody may write someone else's lesson
// from their fork. To offer work back, a forker opens a pull request against the
// lesson; the lesson's author — or one of the trusted collaborators they named —
// reviews it and merges it in. Everything a proposal needs to survive that round
// trip is captured when it is opened, so nothing moves under the reviewer.
//
//   GET  /lessons/:id/pulls                 public* -> { pulls: PullRequest[] }
//   POST /lessons/:id/pulls                 Bearer  -> { pull }            (anyone but the author)
//   PUT  /lessons/:id/pulls/:prId/pack      Bearer  -> { pull }           (the proposer; the packfile)
//   GET  /lessons/:id/pulls/:prId/pack      public* -> the packfile        (X-Git-Head names its tip)
//   POST /lessons/:id/pulls/:prId/merge     Bearer  -> { pull }            (author or trusted collaborator)
//   POST /lessons/:id/pulls/:prId/close     Bearer  -> { pull }            (proposer, author, trusted, moderator)
//
// *Reads follow the lesson's own visibility (lib/lesson.js canReadLesson): a
//  proposal against a public lesson is public, like a comment on it, and one
//  against a private draft is as private as the draft.
//
// ---- What a pull request holds ----------------------------------------------
//
// The changes themselves are a git packfile — the proposer's whole repository,
// snapshotted at the moment they opened the request and stored in R2 under
// git/pulls/<id>/pack (see lib/lessonGit.js). Because a fork is a genuine clone,
// that pack shares object ids with the lesson's own history, so the reviewer's
// merge is a real three-way merge against the commit the two actually diverged
// from — not a guess.
//
// Snapshotting is deliberate: the proposer carries on editing their fork, and a
// request that silently tracked their branch would mean the reviewer approving
// one thing and merging another.
//
// Opening a request is therefore two steps — insert the row, then upload the
// pack against its id — and a row is `ready` only once the pack has landed. An
// unready request has nothing to review, so it is shown only to the person who
// opened it, who can withdraw it and try again.
//
// ---- Who may merge, and what "merged" means ---------------------------------
//
// Only the lesson's author or a trusted collaborator may merge, and merging is
// not a write of content: the merge happens in the reviewer's own editor, is
// pushed to the lesson's history through PUT /git/:lessonId/pack under their
// credentials, and only *then* is the request marked merged here. This endpoint
// verifies that claim rather than believing it — the merge commit the client
// names must be the head the lesson's stored history now actually points at. So
// "merged" can't be set on a request whose changes were never landed.

import { authorFromUser, bearerToken, clientIp, displayNameOf, isModeratorRole, verifyUserAndRole } from '../lib/auth.js';
import { bannedResponse } from '../lib/bans.js';
import { canReadLesson, fetchLessonRow, isTrustedCollaborator } from '../lib/lesson.js';
import {
	DEFAULT_BRANCH,
	LESSON_ID_RE,
	MAX_PACK_BYTES,
	OID_RE,
	deletePullGit,
	isBranchName,
	isPackfile,
	pullPackKey,
	refsKey,
} from '../lib/lessonGit.js';
import { profanityFilter } from '../lib/profanity.js';
import { supabaseBase, supabaseConfigured, supabaseHeaders, verifySupabaseUser } from '../lib/supabase.js';
import { textResponse, jsonResponse } from '../lib/http.js';
import { createNotification } from './notifications.js';
// The same limits the submission form counts against, so the two can't drift.
import { MAX_PULL_REVISIONS, PULL_BODY_MAX, PULL_TITLE_MAX } from '@spelling-creator/core/pulls';

// How many proposals one person may have open against one lesson at a time.
// High enough that nobody splitting real work across several requests will ever
// meet it; low enough that a lesson's author can't be buried in them.
const MAX_OPEN_PER_AUTHOR = 5;

const PULL_COLUMNS =
	'id,lesson_id,source_lesson_id,author_id,author,title,body,head,head_ref,base,ready,status,merge_commit,resolved_by,resolved_at,created_at,revision,previous_head,updated_at';

/** Map a Supabase `lesson_pull_requests` row to the camelCase shape the frontend expects. */
function rowToPull(row) {
	return {
		id: row.id,
		lessonId: row.lesson_id,
		// The fork this came from, when it is itself a saved lesson — the frontend
		// links to it so a reviewer can see the proposal in context. Null when the
		// proposal was opened from an unsaved local fork, or the fork is now gone.
		sourceLessonId: row.source_lesson_id || null,
		authorId: row.author_id,
		author: row.author,
		title: row.title,
		body: row.body || '',
		// The commit the stored pack points at, and the lesson tip it was built on.
		head: row.head,
		base: row.base || null,
		// Which branch of the fork this is, when it isn't the fork's own lesson.
		headRef: row.head_ref || null,
		// How many times the proposer has uploaded, and what the proposal pointed
		// at before the most recent time — enough to show "updated, and here is
		// what that update changed" without keeping a pack per revision.
		revision: row.revision || 1,
		previousHead: row.previous_head || null,
		updatedAt: row.updated_at || null,
		// False until the packfile landed — see the note at the top of this file.
		ready: Boolean(row.ready),
		status: row.status,
		mergeCommit: row.merge_commit || null,
		resolvedBy: row.resolved_by || null,
		resolvedAt: row.resolved_at || null,
		createdAt: row.created_at,
	};
}

/** Fetch one pull request row, scoped to the lesson it claims to belong to. */
async function fetchPull(env, base, lessonId, pullId) {
	let res;
	try {
		res = await fetch(
			`${base}/rest/v1/lesson_pull_requests?id=eq.${encodeURIComponent(pullId)}&lesson_id=eq.${encodeURIComponent(
				lessonId,
			)}&select=${PULL_COLUMNS}&limit=1`,
			{ headers: supabaseHeaders(env) },
		);
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	const rows = await res.json().catch(() => []);
	return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Apply a patch to one pull request and return the updated row, or null.
 *
 * `expect` names the state the caller believed the row was in — `{ status }`,
 * `{ ready }`, or both — and is folded into the PATCH's own filter rather than
 * checked beforehand. Every caller here reads the row, decides, and then writes,
 * and those two steps are not one operation: two people resolving the same
 * proposal at the same moment would both find it open and both write, and a
 * close landing after a merge would leave a row that is `closed` with a merge
 * commit on it while the changes are in the lesson. Making the transition
 * conditional means the second writer matches no row and gets null back, which
 * callers report as "already resolved" — the outcome that's actually true.
 */
async function patchPull(env, base, pullId, patch, expect = {}) {
	const filters = [`id=eq.${encodeURIComponent(pullId)}`];
	for (const [column, value] of Object.entries(expect)) {
		filters.push(`${column}=eq.${encodeURIComponent(value)}`);
	}
	let res;
	try {
		res = await fetch(`${base}/rest/v1/lesson_pull_requests?${filters.join('&')}&select=${PULL_COLUMNS}`, {
			method: 'PATCH',
			headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json', Prefer: 'return=representation' },
			body: JSON.stringify(patch),
		});
	} catch (e) {
		return null;
	}
	if (!res.ok) return null;
	const rows = await res.json().catch(() => []);
	return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Whether a verified user may merge or close proposals on a lesson: its author,
 * or someone on its trusted-collaborator list. `row` must carry the lesson's doc,
 * since the trusted list lives inside it.
 */
function canReview(row, user) {
	if (!user) return false;
	return row.author_id === user.id || isTrustedCollaborator(row, user);
}

/** The commit the lesson's stored history currently points at, or null. */
async function storedLessonHead(env, lessonId) {
	if (!env.LESSON_GIT) return null;
	const object = await env.LESSON_GIT.get(refsKey(lessonId));
	if (!object) return null;
	const refs = await object.json().catch(() => null);
	return refs && refs.head ? refs.head : null;
}

/**
 * Validate a submitted title and body: length first, then profanity on what the
 * person actually wrote. Same posture as a comment — the whole thing is rejected
 * rather than censored and kept.
 */
function readPullText(body, cors) {
	const title = (body && typeof body.title === 'string' ? body.title : '').trim();
	const text = (body && typeof body.body === 'string' ? body.body : '').trim();

	if (!title) return { error: textResponse('Give your proposal a title so the author knows what it changes.', 400, cors) };
	if (title.length > PULL_TITLE_MAX) {
		return { error: textResponse(`A title is limited to ${PULL_TITLE_MAX} characters.`, 400, cors) };
	}
	if (text.length > PULL_BODY_MAX) {
		return { error: textResponse(`A description is limited to ${PULL_BODY_MAX} characters.`, 400, cors) };
	}
	if (profanityFilter.checkProfanity(`${title}\n${text}`).containsProfanity) {
		return { error: textResponse('This proposal contains language that isn’t allowed. Please revise it and try again.', 422, cors) };
	}
	return { title, text, error: null };
}

/**
 * Pull-request endpoints for one lesson. `pullId` and `action` are empty for the
 * collection (/lessons/:id/pulls); otherwise `action` is 'pack', 'merge' or
 * 'close'.
 */
export async function handlePulls(request, env, lessonId, pullId, action, cors) {
	if (!supabaseConfigured(env)) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (!LESSON_ID_RE.test(lessonId)) return textResponse('Invalid lesson id.', 400, cors);
	if (pullId && !LESSON_ID_RE.test(pullId)) return textResponse('Invalid proposal id.', 400, cors);

	const base = supabaseBase(env);

	if (!pullId) {
		if (request.method === 'GET') return listPulls(request, env, base, lessonId, cors);
		if (request.method === 'POST') return openPull(request, env, base, lessonId, cors);
		return textResponse('Method not allowed.', 405, cors);
	}

	if (action === 'pack') {
		if (request.method === 'GET') return getPullPack(request, env, base, lessonId, pullId, cors);
		if (request.method === 'PUT') return putPullPack(request, env, base, lessonId, pullId, cors);
		return textResponse('Method not allowed.', 405, cors);
	}
	if (action === 'merge' && request.method === 'POST') return mergePull(request, env, base, lessonId, pullId, cors);
	if (action === 'close' && request.method === 'POST') return closePull(request, env, base, lessonId, pullId, cors);

	return textResponse('Not found.', 404, cors);
}

/**
 * GET /lessons/:id/pulls — the proposals against a lesson, newest first.
 *
 * Readable by anyone who can read the lesson. Proposals that never finished
 * uploading their pack are filtered out for everyone but the person who opened
 * them: there is nothing there to review, and a reviewer shouldn't have to tell
 * a half-finished submission from a real one.
 *
 * The response also carries `canReview` — whether the caller may merge or
 * decline these. The frontend needs that to decide which buttons to draw, and
 * it must come from here rather than being worked out in the browser: the answer
 * depends on the lesson's trusted-collaborator list, which is the server's to
 * read. (Every action re-checks it anyway; this only shapes the UI.)
 */
async function listPulls(request, env, base, lessonId, cors) {
	// The doc carries the trusted list, which is only needed to answer `canReview`
	// — so it is only fetched when there's a caller who might be on it.
	const token = bearerToken(request);
	const lesson = await fetchLessonRow(env, base, lessonId, { withDoc: Boolean(token) });
	if (!lesson) return textResponse('Lesson not found.', 404, cors);
	if (!(await canReadLesson(env, base, request, lesson))) {
		return textResponse('Lesson not found.', 404, cors);
	}

	let res;
	try {
		res = await fetch(
			`${base}/rest/v1/lesson_pull_requests?lesson_id=eq.${encodeURIComponent(
				lessonId,
			)}&select=${PULL_COLUMNS}&order=created_at.desc&limit=200`,
			{ headers: supabaseHeaders(env) },
		);
	} catch (e) {
		return textResponse('Could not reach the lesson store.', 502, cors);
	}
	if (!res.ok) return textResponse('Could not load the proposals.', 502, cors);
	const rows = await res.json().catch(() => []);

	// A signed-out listing stays entirely anonymous — no token to verify, nothing
	// hidden to reveal, and nobody to be a reviewer.
	const viewer = token ? await verifySupabaseUser(env, token) : null;

	const pulls = (Array.isArray(rows) ? rows : []).filter((r) => r.ready || (viewer && r.author_id === viewer.id)).map(rowToPull);
	return jsonResponse({ pulls, canReview: canReview(lesson, viewer) }, 200, cors);
}

/**
 * POST /lessons/:id/pulls — open a proposal against a lesson.
 *
 * The row lands unready; the caller then uploads its pack (PUT .../pack), which
 * is what makes it reviewable. The author of the lesson is deliberately refused:
 * they have nothing to propose to themselves, they can simply save.
 */
async function openPull(request, env, base, lessonId, cors) {
	const user = await verifySupabaseUser(env, bearerToken(request));
	if (!user) return textResponse('Please sign in before proposing changes.', 401, cors);

	const banned = await bannedResponse(env, base, request, user, cors);
	if (banned) return banned;

	// Every proposer needs a display name, so a lesson's author never sees a raw
	// email address in their review queue.
	if (!displayNameOf(user)) {
		return textResponse('Please choose a display name before proposing changes.', 403, cors);
	}

	let body;
	try {
		body = await request.json();
	} catch (e) {
		return textResponse('Invalid JSON body', 400, cors);
	}

	const parsed = readPullText(body, cors);
	if (parsed.error) return parsed.error;

	// The commit the pack we're about to be sent will point at. Pinned now so the
	// upload can be checked against it, rather than trusting whatever tip arrives.
	const head = (body && typeof body.head === 'string' ? body.head : '').trim();
	if (!OID_RE.test(head)) return textResponse('Missing or invalid proposal head.', 400, cors);
	const baseOid = (body && typeof body.base === 'string' ? body.base : '').trim();

	const lesson = await fetchLessonRow(env, base, lessonId, { withDoc: true });
	if (!lesson) return textResponse('Lesson not found.', 404, cors);
	if (!(await canReadLesson(env, base, request, lesson))) {
		return textResponse('Lesson not found.', 404, cors);
	}
	// The fork this came from, when it is itself a saved lesson. Only recorded if
	// it really is the caller's: it becomes a link shown next to their name, and
	// nobody should be able to point that at a lesson they don't own. A bad value
	// is dropped rather than rejected — the pack is what carries the changes.
	//
	// Resolved before the own-lesson check below, which turns on it.
	const headRef = typeof body.headRef === 'string' ? body.headRef.trim() : '';

	let sourceLessonId = null;
	// Whether that source is a fork *of this lesson*, which is a stricter thing and
	// the only one that may unlock a self-proposal below.
	let sourceForkedFromThis = false;
	const claimed = typeof body.sourceLessonId === 'string' ? body.sourceLessonId.trim() : '';
	if (LESSON_ID_RE.test(claimed) && claimed !== lessonId) {
		const source = await fetchLessonRow(env, base, claimed);
		if (source && source.author_id === user.id) {
			sourceLessonId = claimed;
			sourceForkedFromThis = source.forked_from === lessonId;
		}
	}

	// Proposing to your own lesson is refused when there is nothing behind it: you
	// can simply save, and a request to yourself out of nowhere is a mistake.
	//
	// It is allowed when it carries a fork *of this lesson* that you own, because
	// then it means something specific and useful — "here is a copy with changes in
	// it, let me read the diff before it lands". That is the shape of an AI
	// assistant's work: over MCP the assistant acts as the account it is signed in
	// with, so changes it proposes to the user's own lesson arrive from the user's
	// own id (see apps/mcp/src/git.js). Holding them in the review queue is the
	// whole point — the lesson is untouched until a person reads the diff and merges
	// it. A human gets the same route via "fork into a new lesson" in the editor.
	//
	// Ownership of the source alone is deliberately not enough: any other lesson of
	// theirs would satisfy that, which would turn the rule off entirely and attach a
	// fork link to something that isn't one.
	if (lesson.author_id === user.id && !sourceForkedFromThis) {
		return textResponse('This is your own lesson — save your changes to it directly instead.', 400, cors);
	}

	// Cap what one person can have open against one lesson at a time.
	let openRes;
	try {
		openRes = await fetch(
			`${base}/rest/v1/lesson_pull_requests?lesson_id=eq.${encodeURIComponent(lessonId)}&author_id=eq.${encodeURIComponent(
				user.id,
			)}&status=eq.open&select=id`,
			{ headers: supabaseHeaders(env) },
		);
	} catch (e) {
		return textResponse('Could not reach the lesson store.', 502, cors);
	}
	if (!openRes.ok) return textResponse('Could not open the proposal.', 502, cors);
	const openRows = await openRes.json().catch(() => []);
	if (Array.isArray(openRows) && openRows.length >= MAX_OPEN_PER_AUTHOR) {
		return textResponse(
			`You already have ${MAX_OPEN_PER_AUTHOR} open proposals on this lesson. Wait for one to be reviewed, or withdraw one first.`,
			409,
			cors,
		);
	}

	const insert = {
		lesson_id: lessonId,
		source_lesson_id: sourceLessonId,
		author_id: user.id,
		author: authorFromUser(user),
		title: parsed.title,
		body: parsed.text || null,
		head,
		// Which branch of their fork this is, when it isn't the fork itself. Purely
		// for display, and validated as a branch name because it is shown verbatim
		// in the review queue.
		head_ref: isBranchName(headRef) && headRef !== DEFAULT_BRANCH ? headRef : null,
		base: OID_RE.test(baseOid) ? baseOid : null,
		ready: false,
		status: 'open',
		author_ip: clientIp(request) || null,
	};

	let res;
	try {
		res = await fetch(`${base}/rest/v1/lesson_pull_requests?select=${PULL_COLUMNS}`, {
			method: 'POST',
			headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json', Prefer: 'return=representation' },
			body: JSON.stringify(insert),
		});
	} catch (e) {
		return textResponse('Could not reach the lesson store.', 502, cors);
	}
	if (!res.ok) return textResponse('Could not open the proposal.', 502, cors);
	const rows = await res.json().catch(() => []);
	if (!Array.isArray(rows) || rows.length === 0) {
		return textResponse('Could not open the proposal.', 502, cors);
	}

	// No notification yet: the proposal has nothing in it until its pack arrives.
	// PUT .../pack tells the lesson's author, once there is something to look at.
	return jsonResponse({ pull: rowToPull(rows[0]) }, 201, cors);
}

/**
 * What an upload to a proposal should do — or why it shouldn't.
 *
 * The first upload completes the two-step open, so its tip has to be the one the
 * row was created with. A later one is an update, and must actually move:
 * re-sending the commit we already hold is a no-op dressed as a new revision.
 *
 * `expect` is the conditional the row write carries. Including `head` in it is
 * what makes two of the proposer's own uploads racing safe — the loser finds the
 * row no longer where it read it, and says so rather than overwriting.
 *
 * @returns {{ error: string, status: number } | { updating: boolean, patch: object, expect: object }}
 */
export function planPullUpload(pull, head, now = new Date().toISOString()) {
	const updating = Boolean(pull.ready);

	if (!updating) {
		if (head !== pull.head) {
			return {
				error: 'These changes don’t match the proposal they were opened with. Start the proposal again.',
				status: 409,
			};
		}
		return { updating, patch: { ready: true }, expect: { status: 'open', ready: false, head: pull.head } };
	}

	if (head === pull.head) {
		return { error: 'These changes are already what this proposal contains.', status: 409 };
	}
	const revision = pull.revision || 1;
	if (revision >= MAX_PULL_REVISIONS) {
		return {
			error: `This proposal has been updated ${MAX_PULL_REVISIONS} times. Close it and open a new one.`,
			status: 409,
		};
	}
	return {
		updating,
		patch: { head, previous_head: pull.head, revision: revision + 1, updated_at: now },
		expect: { status: 'open', ready: true, head: pull.head },
	};
}

/**
 * PUT /lessons/:id/pulls/:prId/pack — upload the proposal's packfile.
 *
 * The proposer's only, while the request is open.
 *
 * ---- Updating an open proposal ----------------------------------------------
 *
 * This used to be a once-only write, so that a reviewer could not have the
 * contents swapped out from under them. That reasoning is right and is kept — but
 * the consequence was that changing a proposal meant closing it and opening a new
 * one, which threw away the conversation attached to it.
 *
 * So an upload to an already-ready proposal is allowed, and *recorded*: the
 * revision number goes up, the head it used to point at is kept, and the row's
 * `updated_at` says when. A reviewer is never silently shown different bytes; they
 * are shown that it changed, and what the change was. The stability that mattered
 * was never immutability, it was that nothing moves without saying so.
 *
 * One pack per proposal, not one per revision. The proposer's branch only moves
 * forward, so the commit the previous revision pointed at is still reachable in
 * the new pack — which is what lets "what changed in this update" be answered
 * from the pack we already store.
 *
 * That forward-only rule is enforced by the client, not here: verifying it means
 * walking the commit graph, and this Worker holds a proposal's history as an
 * opaque packfile with no filesystem to index one into — the same limit that
 * stops the merge endpoint checking ancestry (see mergePull below). The exposure
 * is bounded the same way, too: the only proposal a proposer can rewrite is their
 * own, which they could always have closed and reopened instead.
 */
async function putPullPack(request, env, base, lessonId, pullId, cors) {
	if (!env.LESSON_GIT) return textResponse('Lesson history is not configured.', 500, cors);

	const user = await verifySupabaseUser(env, bearerToken(request));
	if (!user) return textResponse('Please sign in before proposing changes.', 401, cors);

	const banned = await bannedResponse(env, base, request, user, cors);
	if (banned) return banned;

	const pull = await fetchPull(env, base, lessonId, pullId);
	if (!pull) return textResponse('Proposal not found.', 404, cors);
	if (pull.author_id !== user.id) return textResponse('You can only upload changes for your own proposal.', 403, cors);
	if (pull.status !== 'open') return textResponse('This proposal is no longer open.', 409, cors);

	const head = (request.headers.get('X-Git-Head') || '').trim();
	if (!OID_RE.test(head)) return textResponse('Missing or invalid X-Git-Head.', 400, cors);

	const plan = planPullUpload(pull, head);
	if (plan.error) return textResponse(plan.error, plan.status, cors);
	const { updating } = plan;

	const declared = Number(request.headers.get('Content-Length') || 0);
	if (declared > MAX_PACK_BYTES) return textResponse('This proposal has too much history to store.', 413, cors);

	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength === 0) return textResponse('Empty packfile.', 400, cors);
	if (bytes.byteLength > MAX_PACK_BYTES) return textResponse('This proposal has too much history to store.', 413, cors);
	if (!isPackfile(bytes)) return textResponse('That is not a packfile.', 400, cors);

	await env.LESSON_GIT.put(pullPackKey(pullId), bytes, {
		httpMetadata: { contentType: 'application/x-git-packfile' },
		customMetadata: { head },
	});

	// The pack is stored before the row is flipped: `ready` means "there is
	// something to review", so it must never be true ahead of the bytes.
	//
	// Conditional on the request still being open, and on it still pointing where
	// we read it pointing. The status was checked above, but the row can be closed
	// between that read and this write — and a close deletes the pack, so an
	// unconditional write would leave a resolved proposal advertising bytes that
	// were just swept, or bytes we wrote back after the sweep. The head condition
	// does the same job for two of the proposer's own uploads racing. When the
	// transition doesn't take, the pack we just stored is ours to clean up.
	const updated = await patchPull(env, base, pullId, plan.patch, plan.expect);
	if (!updated) {
		// Only the *first* upload owns the bytes it just wrote. An update that lost
		// the race leaves the pack ahead of its row, which is harmless: the pack is
		// a superset and getPullPack serves the row's head. Deleting it, by
		// contrast, would strand a proposal that is still perfectly valid.
		if (!updating) await deletePullGit(env, pullId);
		return textResponse('This proposal is no longer open.', 409, cors);
	}

	// Now there is something to look at, tell the lesson's author. Best-effort —
	// never fail a proposal that has landed over a notification that hasn't.
	//
	// A proposal from the author's own account is notified too, and is the case
	// that needs it most: it is how an AI assistant working over MCP offers changes
	// (see openPull above), and the notification is the only thing that tells the
	// author there is something waiting. The wording doesn't claim someone else
	// wrote it, because the account says otherwise; the proposal's own body records
	// what opened it.
	const lesson = await fetchLessonRow(env, base, lessonId);
	if (lesson) {
		const own = lesson.author_id === user.id;
		const who = authorFromUser(user);
		await createNotification(env, base, {
			userId: lesson.author_id,
			type: 'pull_request',
			title: updating
				? own
					? 'Changes waiting for your review were updated'
					: `${who} updated the changes they proposed`
				: own
					? 'Changes are waiting for your review'
					: `${who} proposed changes to your lesson`,
			body: pull.title,
			link: `/hub/${lessonId}/proposals/${pullId}`,
		}).catch(() => {});
	}

	return jsonResponse({ pull: rowToPull(updated) }, 200, cors);
}

/**
 * GET /lessons/:id/pulls/:prId/pack — download the proposal's packfile.
 *
 * Public for a public lesson: a proposal to change a published lesson is part of
 * that lesson's public conversation, exactly like a comment on it. The reviewer
 * indexes these objects into the lesson's own repository, where they meet the
 * commits they share, and merges from there.
 */
async function getPullPack(request, env, base, lessonId, pullId, cors) {
	if (!env.LESSON_GIT) return textResponse('Lesson history is not configured.', 500, cors);

	const lesson = await fetchLessonRow(env, base, lessonId);
	if (!lesson) return textResponse('Lesson not found.', 404, cors);
	if (!(await canReadLesson(env, base, request, lesson))) {
		return textResponse('Lesson not found.', 404, cors);
	}

	const pull = await fetchPull(env, base, lessonId, pullId);
	if (!pull || !pull.ready) return textResponse('Proposal not found.', 404, cors);

	const object = await env.LESSON_GIT.get(pullPackKey(pullId));
	if (!object) return textResponse('This proposal’s changes are no longer stored.', 404, cors);

	const headers = new Headers(cors);
	headers.set('Content-Type', 'application/x-git-packfile');
	// A proposal's pack never changes once uploaded, but it is deleted when the
	// proposal is resolved — so it may be cached briefly, never indefinitely.
	headers.set('Cache-Control', 'private, max-age=60');
	// The *row* names the tip, in preference to the object's own metadata — the
	// reverse of how a lesson's pack works, and for a reason particular to
	// proposals. An update writes the pack before it moves the row, so between
	// those two the stored bytes are ahead of the record. The bytes are a superset
	// either way (a proposal only ever moves forward), so serving the row's head
	// with them hands a reviewer exactly the revision the proposal claims to be,
	// whichever way that write went.
	const head = pull.head || object.customMetadata?.head || '';
	if (head) headers.set('X-Git-Head', head);
	// The SPA reads X-Git-Head cross-origin, which needs it explicitly exposed.
	headers.set('Access-Control-Expose-Headers', 'X-Git-Head');
	if (object.httpEtag) headers.set('ETag', object.httpEtag);
	return new Response(object.body, { status: 200, headers });
}

/**
 * POST /lessons/:id/pulls/:prId/merge — record that a proposal has been merged.
 *
 * The lesson's author or a trusted collaborator only. The merge itself happened
 * in their editor and was pushed to the lesson's history before this call, so
 * what's left is to mark the request resolved.
 *
 * ---- What this actually proves, and what it doesn't ------------------------
 *
 * `mergeCommit` must be the commit the lesson's stored history now points at.
 * That is checked rather than believed, and it rules out the failure that
 * matters in practice: a client marking proposals merged while dropping them on
 * the floor, leaving a lesson whose record of what happened to it is fiction.
 * A lesson with no stored history at all can't have been merged into, so that's
 * refused too — the reviewer's own push is what puts the history there.
 *
 * What it does *not* prove is that the commit it names descends from this
 * particular proposal. Establishing that means walking the commit graph, and the
 * Worker holds the history as an opaque packfile — it has no filesystem to index
 * one into, so it cannot read the ancestry. A reviewer could therefore merge
 * proposal A and record proposal B against it.
 *
 * That gap is bounded by who can reach it: only the lesson's author and the
 * collaborators they trust, who can already rewrite the lesson however they
 * like, and who can simply close a proposal they don't want. So the exposure is
 * a mislabelled record, not a way in. And nothing is destroyed by it — the
 * proposal's pack is kept (see below), so a merge recorded in error can be read
 * back and settled properly.
 */
async function mergePull(request, env, base, lessonId, pullId, cors) {
	const user = await verifySupabaseUser(env, bearerToken(request));
	if (!user) return textResponse('Please sign in first.', 401, cors);

	const banned = await bannedResponse(env, base, request, user, cors);
	if (banned) return banned;

	let body;
	try {
		body = await request.json();
	} catch (e) {
		return textResponse('Invalid JSON body', 400, cors);
	}
	const mergeCommit = (body && typeof body.mergeCommit === 'string' ? body.mergeCommit : '').trim();
	if (!OID_RE.test(mergeCommit)) return textResponse('Missing or invalid merge commit.', 400, cors);

	// withDoc: the trusted list, which decides who may merge, lives in the doc.
	const lesson = await fetchLessonRow(env, base, lessonId, { withDoc: true });
	if (!lesson) return textResponse('Lesson not found.', 404, cors);
	if (!canReview(lesson, user)) {
		return textResponse('Only this lesson’s author or a trusted collaborator can merge a proposal.', 403, cors);
	}

	const pull = await fetchPull(env, base, lessonId, pullId);
	if (!pull) return textResponse('Proposal not found.', 404, cors);
	if (pull.status !== 'open') return textResponse('This proposal has already been resolved.', 409, cors);
	if (!pull.ready) return textResponse('This proposal has no changes to merge yet.', 409, cors);

	// The merge has to be in the lesson's published history before we call it
	// merged. No stored history means no push landed, which means no merge — the
	// reviewer has to save first, and saying so is far better than recording a
	// merge that didn't happen.
	const head = await storedLessonHead(env, lessonId);
	if (!head || head !== mergeCommit) {
		return textResponse(
			'Save the merged lesson before marking this proposal merged — its history doesn’t contain the merge yet.',
			409,
			cors,
		);
	}

	// Conditional on the proposal still being open: this is the write that races
	// with a concurrent close (see patchPull). Losing the race means somebody
	// resolved it first, which is a 409, not a store failure.
	const updated = await patchPull(
		env,
		base,
		pullId,
		{
			status: 'merged',
			merge_commit: mergeCommit,
			resolved_by: user.id,
			resolved_at: new Date().toISOString(),
		},
		{ status: 'open' },
	);
	if (!updated) return textResponse('This proposal has already been resolved.', 409, cors);

	// The pack is deliberately kept. Its objects are in the lesson's history now,
	// reachable from the merge commit, so it is redundant — but only if the merge
	// really did contain them, and that is the one thing this endpoint can't
	// check (see the note above). Deleting it would make a mistake unrecoverable
	// to save a few KB. It goes when the lesson does.

	if (pull.author_id !== user.id) {
		await createNotification(env, base, {
			userId: pull.author_id,
			type: 'pull_request',
			title: `${authorFromUser(user)} merged your proposed changes`,
			body: pull.title,
			link: `/hub/${lessonId}`,
		}).catch(() => {});
	}

	return jsonResponse({ pull: rowToPull(updated) }, 200, cors);
}

/**
 * POST /lessons/:id/pulls/:prId/close — close a proposal without merging it.
 *
 * The person who opened it (withdrawing), the lesson's author or a trusted
 * collaborator (declining), or a moderator (the same power they have over any
 * other user-submitted text). A closed proposal keeps its row — the conversation
 * stays visible — but its pack is dropped, since there is nothing left to merge.
 */
async function closePull(request, env, base, lessonId, pullId, cors) {
	const { user, role } = await verifyUserAndRole(env, base, request);
	if (!user) return textResponse('Please sign in first.', 401, cors);

	const lesson = await fetchLessonRow(env, base, lessonId, { withDoc: true });
	if (!lesson) return textResponse('Lesson not found.', 404, cors);

	const pull = await fetchPull(env, base, lessonId, pullId);
	if (!pull) return textResponse('Proposal not found.', 404, cors);
	if (pull.status !== 'open') return textResponse('This proposal has already been resolved.', 409, cors);

	const isProposer = pull.author_id === user.id;
	if (!isProposer && !canReview(lesson, user) && !isModeratorRole(role)) {
		return textResponse('You can’t close this proposal.', 403, cors);
	}

	// Conditional, like the merge: whoever resolves it first wins, and the loser
	// is told it's already resolved rather than closing a merged proposal out from
	// under the merge (which would leave a `closed` row carrying a merge commit).
	const updated = await patchPull(
		env,
		base,
		pullId,
		{
			status: 'closed',
			resolved_by: user.id,
			resolved_at: new Date().toISOString(),
		},
		{ status: 'open' },
	);
	if (!updated) return textResponse('This proposal has already been resolved.', 409, cors);

	// Nothing here will ever be merged, so the changes go. (A merged proposal
	// keeps its pack — see mergePull.)
	await deletePullGit(env, pullId);

	// Tell the proposer their work was declined — but not when they withdrew it
	// themselves, and not for a proposal that never became reviewable.
	if (!isProposer && pull.ready) {
		await createNotification(env, base, {
			userId: pull.author_id,
			type: 'pull_request',
			title: `${authorFromUser(user)} closed your proposed changes`,
			body: pull.title,
			link: `/hub/${lessonId}`,
		}).catch(() => {});
	}

	return jsonResponse({ pull: rowToPull(updated) }, 200, cors);
}
