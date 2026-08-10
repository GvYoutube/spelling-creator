// Forking, merging, and pushing — orchestrated.
//
// Forking a lesson clones its repository. Merging compares block ids against the
// commit the two histories share. Pushing sends a history back to the hub. These
// are the flows that make the version control worth having, and they're all a
// handful of calls over the primitives in repo.js / pack.js / merge.js.
//
// Three things to understand here.
//
// 1. A fork keeps a *pointer home*. The hub row records `forkedFrom`, and the
//    fork's repo keeps the original's tip at refs/remotes/upstream/main. Together
//    those let the fork ask "what has the original changed since I left?" and get
//    a real answer — the merge base — rather than having to guess.
//
// 2. Work only ever travels *back* to a lesson through a pull request. A forker
//    cannot push into the lesson they forked, however much they've done to their
//    copy: they submit their history as a proposal (submitPullRequest), and the
//    lesson's author or a trusted collaborator merges it (preparePullMerge +
//    completeMerge) from their own editor. The merge, and the push that follows
//    it, are the reviewer's, under the reviewer's credentials.
//
// 3. A lesson can still have more than one writer — its author and the trusted
//    collaborators they named. So *nobody pushes blind*: before sending a history
//    we compare it with what the hub actually holds (remoteStatus), and we only
//    push a history that already contains that. If the lesson has moved on
//    beneath us, the push is refused (by us here, and by the Worker's
//    compare-and-swap regardless) and the changes are merged first. Without that,
//    whoever saved second would quietly erase the other's work.

import * as git from "isomorphic-git";
import { newId } from "../../id.js";
import { preserveLocalFields } from "../../git/doc.js";
import { DRAFT_REPO, copyRepo, deleteRepo, repoCtx } from "./fs.js";
import { applyResolutions, mergeDocs } from "../../git/merge.js";
import {
  cloneFromPack,
  contains,
  fetchRemotePack,
  mergeBase,
  packRepo,
} from "../../git/pack.js";
import { fetchPack, fetchRefs, pushPack } from "../../git/remote.js";
import {
  closePullRequest,
  createPullRequest,
  fetchPullPack,
  uploadPullPack,
} from "../../pulls.js";
import {
  ORIGIN_REF,
  UPSTREAM_REF,
  commitDoc,
  headOid,
  pullRef,
  readDocAt,
} from "../../git/repo.js";

const EMPTY_AUTO = { merged: [], tookTheirs: [], added: [], removed: [] };

/**
 * How our local history stands against what the hub holds for a lesson.
 *
 * Downloads the remote's pack (its objects join ours — the commits we already
 * share are literally the same objects) and classifies:
 *
 *   fresh      the hub has no history for this lesson yet
 *   identical  we and the hub are on the same commit — nothing to do
 *   ahead      our history contains the hub's tip — safe to push
 *   behind     the hub's history contains ours — someone pushed; we must take it
 *   diverged   both moved independently — merge before pushing
 *
 * `behind` and `diverged` both mean "merge first"; that's `needsMerge`.
 */
export async function remoteStatus({ repoId, lessonId, ref = ORIGIN_REF }) {
  const ctx = repoCtx(repoId);
  const ours = await headOid(ctx);

  const pack = await fetchPack(lessonId).catch(() => null);
  if (!pack) return { state: "fresh", ours, theirs: null, needsMerge: false };

  await fetchRemotePack({ ...ctx, ...pack, ref });
  const theirs = pack.head;

  // Nothing committed locally: whatever the hub has, take it.
  if (!ours) {
    return { state: "behind", ours, theirs, base: null, needsMerge: true };
  }
  if (ours === theirs) {
    return {
      state: "identical",
      ours,
      theirs,
      base: theirs,
      needsMerge: false,
    };
  }

  const base = await mergeBase({ ...ctx, ours, theirs });

  // We already contain their tip, so pushing can only move the lesson forward.
  if (await contains({ ...ctx, oid: ours, ancestor: theirs })) {
    return { state: "ahead", ours, theirs, base, needsMerge: false };
  }
  // They contain ours: someone pushed commits we don't have.
  if (await contains({ ...ctx, oid: theirs, ancestor: ours })) {
    return { state: "behind", ours, theirs, base, needsMerge: true };
  }
  return { state: "diverged", ours, theirs, base, needsMerge: true };
}

/**
 * Merge a lesson's history into ours — the "what would happen" step.
 *
 * Nothing is committed: the editor needs to put any conflicts to the user first.
 * Feed the result to completeMerge().
 *
 * Used for both directions:
 *   pulling the original's changes into a fork (lessonId = the original)
 *   catching up with our own lesson before pushing (lessonId = this lesson)
 *
 * @returns {Promise<null | {
 *   doc, conflicts, auto, ours, theirs, base,
 *   identical,  we're on the same commit — nothing to merge
 *   ahead,      we already contain their tip — nothing to merge, but we have
 *               commits they don't (i.e. something to contribute)
 *   upToDate    identical || ahead — there is nothing to pull
 * }>} null when the lesson has no published history to merge with.
 */
export async function prepareMerge({
  repoId,
  lessonId,
  doc,
  ref = UPSTREAM_REF,
}) {
  const pack = await fetchPack(lessonId).catch(() => null);
  if (!pack) return null;
  return mergeAgainstPack({ repoId, pack, doc, ref });
}

/**
 * Merge a *downloaded* history into ours — the shared core of prepareMerge and
 * preparePullMerge, which differ only in where the pack comes from (a lesson's
 * own published history, or a pull request's snapshot of someone's fork).
 *
 * The objects land in our own store, so the commits the two sides share are
 * literally the same objects and the merge base below is a real answer.
 */
async function mergeAgainstPack({ repoId, pack, doc, ref }) {
  const ctx = repoCtx(repoId);

  await fetchRemotePack({ ...ctx, ...pack, ref });

  const ours = await headOid(ctx);
  const theirs = pack.head;
  if (!ours) return null;

  const identical = ours === theirs;
  const base = identical ? theirs : await mergeBase({ ...ctx, ours, theirs });
  const ahead =
    !identical && (await contains({ ...ctx, oid: ours, ancestor: theirs }));

  if (identical || ahead) {
    return {
      doc,
      conflicts: [],
      auto: EMPTY_AUTO,
      ours,
      theirs,
      base,
      identical,
      ahead,
      upToDate: true,
    };
  }

  const [baseDoc, theirDoc] = await Promise.all([
    base ? readDocAt({ ...ctx, oid: base }) : Promise.resolve(null),
    readDocAt({ ...ctx, oid: theirs }),
  ]);

  // Merge against the doc the user is actually looking at, not the last commit —
  // uncommitted edits must not be silently dropped by a merge.
  const result = mergeDocs(baseDoc, doc, theirDoc);

  return {
    doc: preserveLocalFields(result.doc, doc),
    conflicts: result.conflicts,
    auto: result.auto,
    ours,
    theirs,
    base,
    identical: false,
    ahead: false,
    upToDate: false,
  };
}

/**
 * Finish a merge once the user has settled any conflicts, recording it as a
 * commit with *two* parents — ours and theirs. That's what joins the two
 * histories, so a later merge can find this point as its base.
 *
 * @returns {Promise<object>} The merged doc, as committed.
 */
export async function completeMerge({
  repoId,
  prepared,
  choices = {},
  author,
  theirName,
  currentDoc,
}) {
  const ctx = repoCtx(repoId);

  const resolved = applyResolutions(
    prepared.doc,
    prepared.conflicts,
    choices,
    newId,
  );
  const doc = preserveLocalFields(resolved, currentDoc);

  await commitDoc({
    ...ctx,
    doc,
    author,
    message: mergeSummary(prepared, choices, theirName),
    parents: [prepared.ours, prepared.theirs],
  });

  return doc;
}

/**
 * Push a lesson's history to the hub, so anyone who forks it clones a real
 * repository — and so a trusted collaborator's merge is preserved.
 *
 * Refuses to push a history that doesn't contain what the hub already holds:
 * that would erase whoever pushed it. When that's the case it returns the merge
 * for the caller to put to the user (`needsMerge`), rather than pushing.
 *
 * @returns {Promise<{ pushed: boolean, needsMerge?: boolean, prepared?: object, status: object }>}
 */
export async function pushHistory({ repoId, lessonId, doc, accessToken }) {
  const status = await remoteStatus({ repoId, lessonId, ref: ORIGIN_REF });

  if (status.state === "identical") return { pushed: false, status };

  if (status.needsMerge) {
    const prepared = await prepareMerge({
      repoId,
      lessonId,
      doc,
      ref: ORIGIN_REF,
    });
    return { pushed: false, needsMerge: true, prepared, status };
  }

  const packed = await packRepo(repoCtx(repoId));
  if (!packed) return { pushed: false, status }; // nothing committed yet

  await pushPack(
    lessonId,
    {
      packfile: packed.packfile,
      head: packed.head,
      // The compare-and-swap: null on a lesson with no history yet, otherwise the
      // tip we just confirmed we contain.
      parent: status.theirs,
    },
    accessToken,
  );
  return { pushed: true, status };
}

/**
 * Offer this fork's work back to the lesson it came from, as a pull request.
 *
 * This is the *only* way changes travel from a fork into a lesson. Nothing is
 * written to that lesson here — not its document, not its history. What we send
 * is a snapshot of our repository, which its author or a trusted collaborator
 * can then review and merge (or not) from their own editor.
 *
 * Snapshotting is what makes the request stable: we carry on editing our fork
 * afterwards, and what the reviewer is looking at doesn't move under them.
 *
 * Opening it is two steps — the request, then its pack — because the pack is
 * uploaded against the request's id. If the upload fails, the empty request is
 * withdrawn rather than left in the author's queue with nothing in it.
 *
 * @returns {Promise<object>} The open pull request.
 */
export async function submitPullRequest({
  repoId,
  lessonId,
  title,
  body,
  sourceLessonId = null,
  accessToken,
}) {
  const packed = await packRepo(repoCtx(repoId));
  if (!packed) {
    throw new Error("There is nothing to propose yet — make an edit first.");
  }

  // The lesson's tip as it stands, recorded on the request so a reviewer can see
  // what it was built against. Purely informational: the merge finds its own base
  // from the shared ancestry, which is real, because a fork is a genuine clone.
  const refs = await fetchRefs(lessonId).catch(() => null);

  const pull = await createPullRequest(
    lessonId,
    {
      title,
      body,
      head: packed.head,
      base: refs?.head || null,
      sourceLessonId,
    },
    accessToken,
  );

  try {
    const ready = await uploadPullPack(
      lessonId,
      pull.id,
      { packfile: packed.packfile, head: packed.head },
      accessToken,
    );
    return ready || pull;
  } catch (err) {
    await closePullRequest(lessonId, pull.id, accessToken).catch(() => {});
    throw err;
  }
}

/**
 * Merge a pull request's proposed changes into this lesson — the reviewer's side
 * of the flow, and the mirror of prepareMerge.
 *
 * The proposal's pack is indexed into the lesson's own repository, where its
 * objects meet the commits the two histories already share, so this is a true
 * three-way merge against the commit they diverged from — the same block-by-block
 * merge as pulling an original's changes into a fork, in the other direction.
 *
 * Nothing is committed: any conflicts go to the user first. Feed the result to
 * completeMerge(), then push the lesson (pushHistory) and only then mark the
 * request merged — the Worker checks that the merge really landed before it will
 * accept that.
 *
 * @returns {Promise<null | object>} null when the proposal's changes are no
 *          longer stored (it was resolved while we were looking at it). Anything
 *          else — signed out, offline, a failing server — throws, because those
 *          are not the same answer: reporting a proposal as gone when the
 *          network dropped sends the reviewer looking for the wrong problem.
 */
export async function preparePullMerge({
  repoId,
  lessonId,
  pullId,
  doc,
  accessToken,
}) {
  const pack = await fetchPullPack(lessonId, pullId, accessToken);
  if (!pack) return null;
  return mergeAgainstPack({ repoId, pack, doc, ref: pullRef(pullId) });
}

/**
 * Fork a lesson: clone its published repository into the local draft repo.
 *
 * The clone carries the original's full history and, crucially, its commit oids —
 * so the fork and the original share ancestry and can be merged later. Returns
 * the doc at the cloned head, or null when the lesson has no published repo (an
 * older lesson, from before this feature): the caller then falls back to seeding
 * a fresh repo from the lesson's plain doc, which still gives the fork history
 * from that point on, just no common ancestor with the original.
 */
export async function forkLessonRepo(sourceLessonId) {
  const pack = await fetchPack(sourceLessonId).catch(() => null);
  if (!pack) return null;

  // A fork starts from a clean draft repo — any earlier draft history belongs to
  // a different lesson and must not be grafted onto this one.
  await deleteRepo(DRAFT_REPO);

  const ctx = repoCtx(DRAFT_REPO);
  await cloneFromPack({ ...ctx, ...pack });

  // Record where we came from, so the first sync has a base even before it
  // fetches anything new.
  await fetchRemotePack({ ...ctx, ...pack, ref: UPSTREAM_REF });

  return readDocAt({ ...ctx, oid: pack.head });
}

/**
 * Fork a lesson we already hold locally — the editor's "fork into a new lesson",
 * which detaches the open lesson so the next save creates a separate one.
 *
 * Same idea as forking from the hub, without the download: copy the repository
 * into the draft slot and remember where it came from. The new lesson keeps the
 * original's history and shares ancestry with it, so it can be merged back later.
 */
export async function forkLocalRepo(sourceRepoId) {
  const copied = await copyRepo(sourceRepoId, DRAFT_REPO);
  if (!copied) return false;

  const ctx = repoCtx(DRAFT_REPO);
  const head = await headOid(ctx);
  if (head) {
    await git.writeRef({ ...ctx, ref: UPSTREAM_REF, value: head, force: true });
  }
  return true;
}

function mergeSummary(prepared, choices, theirName) {
  const name = theirName ? `"${theirName}"` : "the original lesson";
  const lines = [`Merge ${name}`, ""];

  const { auto, conflicts } = prepared;
  if (auto.added.length)
    lines.push(`- ${auto.added.length} block(s) added upstream`);
  if (auto.tookTheirs.length) {
    lines.push(`- ${auto.tookTheirs.length} block(s) updated upstream`);
  }
  if (auto.merged.length) {
    lines.push(
      `- ${auto.merged.length} block(s) merged field-by-field (both sides' edits kept)`,
    );
  }
  if (auto.removed.length) {
    lines.push(`- ${auto.removed.length} block(s) removed upstream`);
  }
  for (const conflict of conflicts) {
    const choice = choices[conflict.blockId] || "ours";
    const fields = conflict.fields.map((f) => f.field).join(", ");
    lines.push(
      `- resolved ${conflict.blockId}${fields ? ` (${fields})` : ""}: kept ${choice}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
