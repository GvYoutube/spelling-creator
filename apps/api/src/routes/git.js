// A lesson's version history, stored as a git packfile in R2.
//
// The editor keeps each lesson in a real git repository in the browser (one file
// per content block, named by its block id — see web/src/lib/git/). For someone
// else to *fork* a lesson, that repository has to travel, so the author uploads
// it here the way git itself moves history: as a packfile holding every object
// reachable from the lesson's branch, plus the commit its branch points at.
//
//   GET /git/:lessonId/refs   public* -> { head, refs, size, updatedAt } | 404
//   GET /git/:lessonId/pack   public* -> the packfile (X-Git-Head names its tip,
//                                        X-Git-Refs every branch it holds)
//   PUT /git/:lessonId/pack   Bearer   -> store it (the author, or a trusted collaborator)
//
// A pull request's proposed history is a packfile too, but it belongs to the
// request rather than to the lesson and lives under its own routes — see
// routes/pulls.js.
//
// *A private draft's (published = false) history is not public — only its
//  author, a trusted collaborator, or a moderator/admin may read it, same as
//  GET /lessons/:id.
//
// A forker downloads the pack, indexes it into their own object store, and holds
// a genuine clone: same commits, same oids, shared ancestry — which is what lets
// the two be merged later against their true common ancestor.
//
// Two R2 objects per lesson, mirroring the /images routes' use of the bucket:
//   git/<lessonId>/pack        the packfile bytes
//   git/<lessonId>/refs.json   { head, refs, size, updatedAt }
//
// The pack carries its own tip *and* its branch map in its object metadata (echoed in
// the X-Git-Head and X-Git-Refs response headers). A clone therefore reads both
// from the *same object* as the bytes, so it can never pair a new refs.json with
// a stale pack.
//
// ---- More than one branch ---------------------------------------------------
//
// `head` is the lesson: the default branch, and the only one a reader, a forker
// or the lesson's own page ever asks for. `refs` maps every branch the repository
// holds to its tip — one per *variation* its author is trying out, kept here so a
// variation follows the lesson between the author's devices rather than living
// only in the browser it was started in.
//
// A variation is exactly as public as the lesson it belongs to: it is in the same
// pack, and the pack of a published lesson is public so that forking is. See
// /web-app/lesson-variations, which says so where an author can read it.
//
// ---- Who may push, and why it can't lose work -------------------------------
//
// Two people can write a lesson's history: its author, and anyone the author put
// on the lesson's trusted-collaborator list. Nobody else — a forker cannot push
// into the lesson they forked, however much work they have done on it. What they
// can do is open a pull request and have one of those two merge it (see
// routes/pulls.js and /web-app/pull-requests); the merge commit is then pushed
// here by the reviewer, under their own credentials.
//
// The moment more than one writer exists, a plain "last write wins" would
// silently destroy history: whoever saved second would replace the other's
// commits with a pack that never contained them.
//
// So a push is a **compare-and-swap**. The client sends `X-Git-Parent`: the head
// it believes is current. If that isn't the head we hold, the push is rejected
// with 409 and the client must fetch, merge, and retry. Since the client only
// pushes a history that already *contains* the head it merged, an accepted push
// can only ever move the lesson forward.
//
// The same rule runs one level down for the variations, per branch:
//
//   X-Git-Refs      the branches to set, `{ "<name>": "<oid>" }`
//   X-Git-Expected  what the client believes we hold for each name it touches,
//                   with "" meaning "I believe this one does not exist yet"
//   X-Git-Deletes   the branches to remove, comma-separated
//
// It is all-or-nothing, which costs nothing to arrange: refs.json is a single
// object and already the commit point, so every branch advances or none does. A
// branch the client doesn't mention is left exactly as it is — that is what stops
// a device which has never heard of a new variation from deleting it by omission,
// and it is why a delete has to be asked for by name rather than inferred.

import { bearerToken } from '../lib/auth.js';
import { bannedResponse } from '../lib/bans.js';
import { canReadLesson, fetchLessonRow, isTrustedCollaborator } from '../lib/lesson.js';
import {
	DEFAULT_BRANCH,
	LESSON_ID_RE,
	MAX_BRANCHES,
	MAX_PACK_BYTES,
	OID_RE,
	isBranchName,
	isPackfile,
	packKey,
	parseRefMap,
	refsKey,
	serializeRefMap,
} from '../lib/lessonGit.js';
import { supabaseBase, supabaseConfigured, verifySupabaseUser } from '../lib/supabase.js';
import { textResponse, jsonResponse } from '../lib/http.js';
import { gitStore } from '../platform/index.js';

/** What we currently hold for a lesson: `{ head, refs }`, or null with no history. */
async function stored(env, lessonId) {
	const object = await gitStore(env).get(refsKey(lessonId));
	if (!object) return null;
	const value = await object.json().catch(() => null);
	if (!value || !value.head) return null;

	// A lesson stored before variations existed has no map; the one branch it has
	// is its head, and saying so here means the rest of this file has one shape to
	// reason about rather than two.
	//
	// A map that is *present but unreadable* is a different thing entirely, and must
	// not be flattened into the same answer. Both of parseRefMap's limits — the
	// branch count and the name rules — can be tightened later, and if either is,
	// every lesson past the new limit would read as single-branch here: the push
	// path would skip its old-client guard and write the variations away. So say we
	// don't know, and let the caller refuse.
	const refs = value.refs === undefined ? { [DEFAULT_BRANCH]: value.head } : parseRefMap(value.refs);
	if (!refs) return { head: value.head, refs: null, unreadable: true };
	return { head: value.head, refs };
}

/**
 * Apply a push's ref instructions to what we hold, or explain why we won't.
 *
 * The rule is the one that has always guarded this endpoint, applied per branch
 * rather than to the lesson as a whole: a client may only move a branch it has
 * already seen the current state of. `expected` is what it believes, and a branch
 * it doesn't mention at all is left untouched — which is what stops a device that
 * has never heard of somebody's new variation from deleting it by omission.
 *
 * @returns {{ refs: object } | { error: string, status: number }}
 */
export function applyRefs(current, { refs, deletes, expected }) {
	const next = { ...current };

	const believes = (name) => (Object.hasOwn(expected, name) ? expected[name] : null);
	const mismatch = (name) => {
		const believed = believes(name);
		// Nothing claimed about this branch: only safe when it is new to us. Moving
		// one we already hold without saying what we hold is exactly the overwrite
		// the compare-and-swap exists to refuse.
		if (believed === null) return Boolean(current[name]);
		return (current[name] || '') !== believed;
	};

	// A name in both halves is a request that contradicts itself, and we cannot know
	// which half was meant. Refusing is the only honest answer — applying them in
	// order would silently let the delete win, which is how a branch that is alive
	// on the client disappears from the hub.
	for (const name of deletes) {
		if (Object.hasOwn(refs, name)) {
			return { error: 'That push asks to both keep and remove the same version.', status: 400 };
		}
	}

	for (const name of Object.keys(refs)) {
		if (mismatch(name)) return { error: 'moved', status: 409 };
		next[name] = refs[name];
	}
	for (const name of deletes) {
		if (!isBranchName(name)) return { error: 'That is not a branch name.', status: 400 };
		if (mismatch(name)) return { error: 'moved', status: 409 };
		delete next[name];
	}

	// The lesson has to still be there afterwards. Deleting the branch that *is*
	// the lesson would leave a row whose history advertises a tip nothing points
	// at, and no client asks for that.
	if (!next[DEFAULT_BRANCH]) return { error: 'The lesson’s own history cannot be removed.', status: 400 };
	if (Object.keys(next).length > MAX_BRANCHES) {
		return { error: `A lesson can have at most ${MAX_BRANCHES} versions.`, status: 400 };
	}
	return { refs: next };
}

/**
 * Whether a reader may see this lesson's history. The rule is the lesson's own
 * (lib/lesson.js canReadLesson): a private draft or a shadowbanned lesson is
 * invisible to the public but stays readable to its author (who must not realise
 * a shadowban is in effect), a trusted collaborator, and moderators. Returns a
 * 404 response to send back, or null when the read is allowed.
 */
async function readable(request, env, base, row, cors) {
	if (await canReadLesson(env, base, request, row)) return null;
	return textResponse('Lesson not found.', 404, cors);
}

/**
 * The lesson's history endpoints. `rest` is the path after /git/:lessonId —
 * "/refs" or "/pack".
 */
export async function handleGit(request, env, lessonId, rest, cors) {
	const store = gitStore(env);
	if (!store) {
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

		const object = await store.get(refsKey(lessonId));
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

		const object = await store.get(packKey(lessonId));
		if (!object) return textResponse('This lesson has no history.', 404, cors);

		const headers = new Headers(cors);
		headers.set('Content-Type', 'application/x-git-packfile');
		// The pack is replaced in place whenever the author saves, so it must not be
		// cached: a stale pack would be missing the commits refs advertises.
		headers.set('Cache-Control', 'no-store');
		const head = object.metadata.head || '';
		if (head) headers.set('X-Git-Head', head);
		// The branch map comes off the *same object* as the bytes, for the reason the
		// head does: a map read from refs.json a moment later could name a tip this
		// pack doesn't contain.
		const refs = object.metadata.refs || '';
		if (refs) headers.set('X-Git-Refs', refs);
		// The SPA reads these cross-origin, which needs them explicitly exposed.
		headers.set('Access-Control-Expose-Headers', 'X-Git-Head, X-Git-Refs');
		if (object.etag) headers.set('ETag', object.etag);
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

		// The author, or someone the author trusts — the two people who may write
		// this lesson, whether they are saving their own edit or pushing a pull
		// request they have just merged. Don't reveal which of "missing" or "not
		// yours" it was.
		const isAuthor = row.author_id === user.id;
		if (!isAuthor && !isTrustedCollaborator(row, user)) {
			return textResponse('You can only save history for lessons you published, or lessons you are a trusted collaborator on.', 403, cors);
		}

		const head = (request.headers.get('X-Git-Head') || '').trim();
		if (!OID_RE.test(head)) {
			return textResponse('Missing or invalid X-Git-Head.', 400, cors);
		}

		// What the client wants to happen to the lesson's branches. A client that
		// sends none of this is one written before a lesson could have more than one
		// branch: it means "move the lesson, leave everything else alone", and the
		// two X-Git-Head/X-Git-Parent headers already say that.
		const requested = parseRefMap(request.headers.get('X-Git-Refs'));
		const believed = parseRefMap(request.headers.get('X-Git-Expected'));
		if (request.headers.get('X-Git-Refs') && !requested) {
			return textResponse('Invalid X-Git-Refs.', 400, cors);
		}
		if (request.headers.get('X-Git-Expected') && !believed) {
			return textResponse('Invalid X-Git-Expected.', 400, cors);
		}
		// A ref being *set* must name a real commit; only X-Git-Expected may say ""
		// (meaning "I believe this branch does not exist yet").
		if (requested && Object.values(requested).some((oid) => !OID_RE.test(oid))) {
			return textResponse('Invalid X-Git-Refs.', 400, cors);
		}

		const deletes = (request.headers.get('X-Git-Deletes') || '')
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean);

		// Compare-and-swap. `parent` is the head the client merged before building
		// this pack; if the lesson has moved on since (someone else pushed), we
		// refuse — accepting would drop their commits. 409 tells the client to
		// fetch, merge and try again.
		const parent = (request.headers.get('X-Git-Parent') || '').trim();
		const held = await stored(env, lessonId);
		const current = held?.head || null;

		// We hold a branch map we can't read. Every path below decides what to keep
		// and what to drop by comparing against it, so none of them can run safely.
		if (held?.unreadable) {
			return textResponse('This lesson’s stored history could not be read. Please report this rather than saving over it.', 409, cors);
		}

		if (current && parent !== current) {
			return textResponse(
				'This lesson’s history has moved on since you last synced. Merge the latest changes, then save again.',
				409,
				cors,
			);
		}

		// A pack holds every object every branch it advertises needs. An old client
		// packs only the lesson's own branch, so accepting its pack while keeping a
		// variation's tip in the map would leave that tip pointing at objects the
		// stored pack no longer contains — a history that can't be cloned. Rather
		// than silently drop the variation, refuse and say why.
		const heldBranches = Object.keys(held?.refs || {});
		if (!requested && heldBranches.length > 1) {
			return textResponse(
				'This lesson has more than one version, which this client cannot save without dropping them. Please update it, or save from the web editor.',
				409,
				cors,
			);
		}

		const applied = applyRefs(held?.refs || {}, {
			refs: requested || { [DEFAULT_BRANCH]: head },
			deletes,
			expected: believed || (current ? { [DEFAULT_BRANCH]: current } : {}),
		});
		if (applied.error) {
			return textResponse(
				applied.status === 409
					? 'One of this lesson’s versions has moved on since you last synced. Merge the latest changes, then save again.'
					: applied.error,
				applied.status,
				cors,
			);
		}
		// The lesson's own tip and the map have to agree — they are two readings of
		// one fact, and a client that disagrees with itself is one we can't apply.
		if (applied.refs[DEFAULT_BRANCH] !== head) {
			return textResponse('X-Git-Head and X-Git-Refs disagree about this lesson.', 400, cors);
		}

		// Already there — the client is re-pushing exactly what we hold, branches and
		// all. Nothing to write.
		if (current && current === head && serializeRefMap(applied.refs) === serializeRefMap(held.refs)) {
			const object = await store.get(refsKey(lessonId));
			const existing = object ? await object.json().catch(() => null) : null;
			if (existing) return jsonResponse(existing, 200, cors);
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
		if (!isPackfile(bytes)) {
			return textResponse('That is not a packfile.', 400, cors);
		}

		// Write the pack before the refs. The refs object is the commit point: if the
		// pack write fails, refs still names the previous (complete) pack, and a
		// clone of the old history beats a clone of a half-written one.
		const map = serializeRefMap(applied.refs);
		await store.put(packKey(lessonId), bytes, {
			contentType: 'application/x-git-packfile',
			metadata: { head, refs: map },
		});
		const refs = { head, refs: applied.refs, size: bytes.byteLength, updatedAt: new Date().toISOString() };
		await store.put(refsKey(lessonId), JSON.stringify(refs), {
			contentType: 'application/json',
		});

		return jsonResponse(refs, 200, cors);
	}

	return textResponse('Method not allowed.', 405, cors);
}
