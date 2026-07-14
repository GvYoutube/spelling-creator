// A lesson's version history, stored as a git packfile in R2.
//
// The editor keeps each lesson in a real git repository in the browser (one file
// per content block, named by its block id — see web/src/lib/git/). For someone
// else to *fork* a lesson, that repository has to travel, so the author uploads
// it here the way git itself moves history: as a packfile holding every object
// reachable from the lesson's branch, plus the commit its branch points at.
//
//   GET /git/:lessonId/refs   public  -> { head, size, updatedAt } | 404
//   GET /git/:lessonId/pack   public  -> the packfile (X-Git-Head names its tip)
//   PUT /git/:lessonId/pack   Bearer  -> store it (the author, or a trusted collaborator)
//
// A forker downloads the pack, indexes it into their own object store, and holds
// a genuine clone: same commits, same oids, shared ancestry — which is what lets
// the two be merged later against their true common ancestor.
//
// Two R2 objects per lesson, mirroring the /images routes' use of the bucket:
//   git/<lessonId>/pack        the packfile bytes
//   git/<lessonId>/refs.json   { head, size, updatedAt }
//
// The pack carries its own tip in customMetadata (and in the X-Git-Head response
// header). A clone therefore reads the head from the *same object* as the bytes,
// so it can never pair a new refs.json with a stale pack.
//
// ---- Who may push, and why it can't lose work -------------------------------
//
// Two people can write a lesson's history: its author, and anyone the author put
// on the lesson's trusted-collaborator list (that's how a trusted collaborator
// merges a fork back in — see /monorepo/version-history). The moment more than
// one writer exists, a plain "last write wins" would silently destroy history:
// whoever saved second would replace the other's commits with a pack that never
// contained them.
//
// So a push is a **compare-and-swap**. The client sends `X-Git-Parent`: the head
// it believes is current. If that isn't the head we hold, the push is rejected
// with 409 and the client must fetch, merge, and retry. Since the client only
// pushes a history that already *contains* the head it merged, an accepted push
// can only ever move the lesson forward.

import { bearerToken, isModeratorRole, verifyUserAndRole } from '../lib/auth.js';
import { bannedResponse } from '../lib/bans.js';
import { fetchLessonRow, isTrustedCollaborator } from '../lib/lesson.js';
import { LESSON_ID_RE, packKey, refsKey } from '../lib/lessonGit.js';
import { supabaseBase, supabaseConfigured, verifySupabaseUser } from '../lib/supabase.js';
import { textResponse, jsonResponse } from '../lib/http.js';

// A commit oid is a 40-char lowercase hex SHA-1.
const OID_RE = /^[0-9a-f]{40}$/;

// Cap one lesson's history. Packs hold only JSON (images are referenced by hash
// and live in the images bucket, not in the repo), so even a long-lived lesson
// with hundreds of commits stays well under this.
const MAX_PACK_BYTES = 10 * 1024 * 1024;

// Every packfile starts with the four bytes "PACK".
const PACK_MAGIC = [0x50, 0x41, 0x43, 0x4b];

/** The head we currently hold for a lesson, or null if it has no history yet. */
async function storedHead(env, lessonId) {
	const object = await env.LESSON_GIT.get(refsKey(lessonId));
	if (!object) return null;
	const refs = await object.json().catch(() => null);
	return refs && refs.head ? refs.head : null;
}

/**
 * Whether a reader may see this lesson's history. Mirrors GET /lessons/:id: a
 * shadowbanned lesson is invisible to the public but stays readable to its author
 * (who must not realise it's hidden) and to moderators.
 */
async function readable(request, env, base, row, cors) {
	if (!row.shadowbanned) return null;
	const { user, role } = await verifyUserAndRole(env, base, request);
	const isOwner = user && user.id === row.author_id;
	if (isOwner || isModeratorRole(role)) return null;
	return textResponse('Lesson not found.', 404, cors);
}

/**
 * The lesson's history endpoints. `rest` is the path after /git/:lessonId —
 * "/refs" or "/pack".
 */
export async function handleGit(request, env, lessonId, rest, cors) {
	if (!env.LESSON_GIT) {
		return textResponse('Lesson history is not configured.', 500, cors);
	}
	if (!supabaseConfigured(env)) {
		return textResponse('Server misconfiguration: Supabase is not configured', 500, cors);
	}
	if (!LESSON_ID_RE.test(lessonId)) {
		return textResponse('Invalid lesson id.', 400, cors);
	}

	const base = supabaseBase(env);

	// GET /git/:lessonId/refs — the tip of the published history. Cheap enough to
	// poll: the editor uses it to notice a fork's original has moved on.
	if (request.method === 'GET' && rest === '/refs') {
		const row = await fetchLessonRow(env, base, lessonId);
		if (!row) return textResponse('Lesson not found.', 404, cors);
		const denied = await readable(request, env, base, row, cors);
		if (denied) return denied;

		const object = await env.LESSON_GIT.get(refsKey(lessonId));
		if (!object) return textResponse('This lesson has no history.', 404, cors);

		const refs = await object.json().catch(() => null);
		if (!refs || !refs.head) return textResponse('This lesson has no history.', 404, cors);
		return jsonResponse(refs, 200, cors);
	}

	// GET /git/:lessonId/pack — the packed history. Public, because forking a
	// published lesson is public. The tip rides along in X-Git-Head so a clone
	// reads the bytes and the ref they belong to from one object.
	if (request.method === 'GET' && rest === '/pack') {
		const row = await fetchLessonRow(env, base, lessonId);
		if (!row) return textResponse('Lesson not found.', 404, cors);
		const denied = await readable(request, env, base, row, cors);
		if (denied) return denied;

		const object = await env.LESSON_GIT.get(packKey(lessonId));
		if (!object) return textResponse('This lesson has no history.', 404, cors);

		const headers = new Headers(cors);
		headers.set('Content-Type', 'application/x-git-packfile');
		// The pack is replaced in place whenever the author saves, so it must not be
		// cached: a stale pack would be missing the commits refs advertises.
		headers.set('Cache-Control', 'no-store');
		const head = object.customMetadata?.head || '';
		if (head) headers.set('X-Git-Head', head);
		// The SPA reads X-Git-Head cross-origin, which needs it explicitly exposed.
		headers.set('Access-Control-Expose-Headers', 'X-Git-Head');
		if (object.httpEtag) headers.set('ETag', object.httpEtag);
		return new Response(object.body, { status: 200, headers });
	}

	// PUT /git/:lessonId/pack — store a packed history. The body is the packfile;
	// X-Git-Head names the commit its branch points at, and X-Git-Parent the head
	// the client believes is current (the compare-and-swap; see the note up top).
	if (request.method === 'PUT' && rest === '/pack') {
		const user = await verifySupabaseUser(env, bearerToken(request));
		if (!user) return textResponse('Please sign in before saving.', 401, cors);

		const banned = await bannedResponse(env, base, request, user, cors);
		if (banned) return banned;

		// withDoc: the trusted-collaborator list lives on the lesson's document.
		const row = await fetchLessonRow(env, base, lessonId, { withDoc: true });
		if (!row) return textResponse('Lesson not found.', 404, cors);

		// The author, or someone the author trusts (who is merging a fork back in).
		// Don't reveal which of "missing" or "not yours" it was.
		const isAuthor = row.author_id === user.id;
		if (!isAuthor && !isTrustedCollaborator(row, user)) {
			return textResponse('You can only save history for lessons you published, or lessons you are a trusted collaborator on.', 403, cors);
		}

		const head = (request.headers.get('X-Git-Head') || '').trim();
		if (!OID_RE.test(head)) {
			return textResponse('Missing or invalid X-Git-Head.', 400, cors);
		}

		// Compare-and-swap. `parent` is the head the client merged before building
		// this pack; if the lesson has moved on since (someone else pushed), we
		// refuse — accepting would drop their commits. 409 tells the client to
		// fetch, merge and try again.
		const parent = (request.headers.get('X-Git-Parent') || '').trim();
		const current = await storedHead(env, lessonId);
		if (current && parent !== current) {
			return textResponse(
				'This lesson’s history has moved on since you last synced. Merge the latest changes, then save again.',
				409,
				cors,
			);
		}
		// Already there — the client is re-pushing a history we hold. Nothing to do.
		if (current && current === head) {
			const object = await env.LESSON_GIT.get(refsKey(lessonId));
			const refs = object ? await object.json().catch(() => null) : null;
			if (refs) return jsonResponse(refs, 200, cors);
		}

		const declared = Number(request.headers.get('Content-Length') || 0);
		if (declared > MAX_PACK_BYTES) {
			return textResponse('This lesson has too much history to store.', 413, cors);
		}

		const bytes = new Uint8Array(await request.arrayBuffer());
		if (bytes.byteLength === 0) return textResponse('Empty packfile.', 400, cors);
		if (bytes.byteLength > MAX_PACK_BYTES) {
			return textResponse('This lesson has too much history to store.', 413, cors);
		}
		// Reject anything that isn't a packfile outright, so the bucket can't be used
		// as general-purpose storage by an authenticated caller.
		if (!PACK_MAGIC.every((b, i) => bytes[i] === b)) {
			return textResponse('That is not a packfile.', 400, cors);
		}

		// Write the pack before the refs. The refs object is the commit point: if the
		// pack write fails, refs still names the previous (complete) pack, and a
		// clone of the old history beats a clone of a half-written one.
		await env.LESSON_GIT.put(packKey(lessonId), bytes, {
			httpMetadata: { contentType: 'application/x-git-packfile' },
			customMetadata: { head },
		});
		const refs = { head, size: bytes.byteLength, updatedAt: new Date().toISOString() };
		await env.LESSON_GIT.put(refsKey(lessonId), JSON.stringify(refs), {
			httpMetadata: { contentType: 'application/json' },
		});

		return jsonResponse(refs, 200, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}
