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
import { diffDocs } from "../../git/ops.js";
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
  BRANCH,
  ORIGIN_REF,
  UPSTREAM_REF,
  branchRef,
  clearDeletedBranch,
  commitDoc,
  currentBranch,
  currentBranchRef,
  deletedBranches,
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
  const branch = await currentBranch(ctx);
  const ours = await headOid(ctx);

  const pack = await fetchPack(lessonId).catch(() => null);
  if (!pack) {
    return {
      state: "fresh",
      ours,
      theirs: null,
      branch,
      hasRemote: false,
      needsMerge: false,
    };
  }

  await fetchRemotePack({
    ...ctx,
    ...pack,
    ref,
    refs: pack.refs,
    remote: "origin",
  });
  await syncRemoteBranches(ctx, pack.refs);

  // Compare like with like: the branch we are on against the hub's copy of *that*
  // branch, not against the lesson. A variation and the lesson are supposed to
  // differ — that is what a variation is — so measuring one against the other
  // would report a conflict on every save.
  const theirs = pack.refs?.[branch] || (branch === BRANCH ? pack.head : null);

  // The hub has never seen this branch, so there is nothing there to overwrite.
  if (!theirs) {
    return {
      state: "fresh",
      ours,
      theirs: null,
      branch,
      hasRemote: true,
      needsMerge: false,
    };
  }

  // Nothing committed locally: whatever the hub has, take it.
  if (!ours) {
    return {
      state: "behind",
      ours,
      theirs,
      base: null,
      branch,
      hasRemote: true,
      needsMerge: true,
    };
  }
  if (ours === theirs) {
    return {
      state: "identical",
      ours,
      theirs,
      base: theirs,
      branch,
      hasRemote: true,
      needsMerge: false,
    };
  }

  const base = await mergeBase({ ...ctx, ours, theirs });

  // We already contain their tip, so pushing can only move the lesson forward.
  if (await contains({ ...ctx, oid: ours, ancestor: theirs })) {
    return {
      state: "ahead",
      ours,
      theirs,
      base,
      branch,
      hasRemote: true,
      needsMerge: false,
    };
  }
  // They contain ours: someone pushed commits we don't have.
  if (await contains({ ...ctx, oid: theirs, ancestor: ours })) {
    return {
      state: "behind",
      ours,
      theirs,
      base,
      branch,
      hasRemote: true,
      needsMerge: true,
    };
  }
  return {
    state: "diverged",
    ours,
    theirs,
    base,
    branch,
    hasRemote: true,
    needsMerge: true,
  };
}

/**
 * Bring our idea of the hub's branches in line with what it just told us.
 *
 * Two halves, and they are both about the next push being able to say something
 * true. Creating local branches for the hub's is what makes a variation started
 * on one device turn up on another — the objects are already here, off the pack
 * we have just indexed, so it costs a ref write. Dropping remote-tracking refs
 * for branches the hub no longer has is what stops us claiming a tip for a branch
 * that isn't there, which the compare-and-swap would refuse for ever.
 *
 * A branch we deliberately deleted is not adopted back: its marker is still
 * waiting to be pushed, and undoing a delete on the way to reporting it would be
 * the opposite of what the author asked for.
 */
async function syncRemoteBranches(ctx, refs) {
  if (!refs) return;
  const deleted = await deletedBranches(ctx);

  for (const [name, oid] of Object.entries(refs)) {
    if (!oid || deleted[name]) continue;
    if (await headOid({ ...ctx, ref: branchRef(name) })) continue;
    await git.writeRef({
      ...ctx,
      ref: branchRef(name),
      value: oid,
      force: false,
    });
  }

  const tracked = await git
    .listRefs({ ...ctx, filepath: "refs/remotes/origin" })
    .catch(() => []);
  for (const name of tracked) {
    if (refs[name]) continue;
    await git
      .deleteRef({ ...ctx, ref: `refs/remotes/origin/${name}` })
      .catch(() => {});
  }
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
  theirs,
}) {
  const pack = await fetchPack(lessonId).catch(() => null);
  if (!pack) return null;
  return mergeAgainstPack({ repoId, pack, doc, ref, theirs });
}

/**
 * Merge a *downloaded* history into ours — the shared core of prepareMerge and
 * preparePullMerge, which differ only in where the pack comes from (a lesson's
 * own published history, or a pull request's snapshot of someone's fork).
 *
 * The objects land in our own store, so the commits the two sides share are
 * literally the same objects and the merge base below is a real answer.
 */
async function mergeAgainstPack({ repoId, pack, doc, ref, theirs }) {
  await fetchRemotePack({ ...repoCtx(repoId), ...pack, ref });
  // `theirs` names which of the pack's commits to merge. It defaults to the
  // lesson itself, which is what pulling an original's changes or reviewing a
  // proposal means — but catching up with our own hub while editing a variation
  // has to merge the hub's copy of *that* variation, or we would fold the whole
  // lesson into the variation and call it a sync.
  return mergeAgainstCommit({ repoId, theirs: theirs || pack.head, doc });
}

/**
 * Merge one commit into the branch we are on — the part of a merge that has
 * nothing to do with where the other side came from.
 *
 * Downloaded from the hub, unpacked from a proposal, or simply another branch of
 * this same repository: by the time we are here it is an oid whose objects we
 * hold, and the answer is the same three-way merge against the commit the two
 * sides last agreed on.
 */
async function mergeAgainstCommit({ repoId, theirs, doc }) {
  const ctx = repoCtx(repoId);

  const ours = await headOid(ctx);
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

  // A fast-forward: their history already contains ours (we are the merge base),
  // and we have nothing of our own on top — no commits, and nothing uncommitted
  // in the editor either. Then "merging" is only moving our branch to theirs, and
  // manufacturing a merge commit for it would put an entry in the lesson's
  // timeline that records no decision and changes no content.
  //
  // Both halves matter. `base === ours` is the commit-graph half; diffing the
  // live document against ours is the half the graph can't see, and skipping it
  // would drop whatever the reviewer had typed but not yet paused long enough to
  // commit.
  const fastForward = base === ours && diffDocs(baseDoc, doc).length === 0;

  return {
    doc: preserveLocalFields(result.doc, doc),
    conflicts: result.conflicts,
    auto: result.auto,
    ours,
    theirs,
    base,
    identical: false,
    ahead: false,
    fastForward,
    upToDate: false,
  };
}

/**
 * Bring a variation into the lesson: the same three-way merge, with both sides
 * already in this repository.
 *
 * The switch happens *first*, and that ordering is the whole of it. A merge
 * commits to the branch you are standing on, so we move to the lesson before
 * preparing anything, and what comes back is the lesson's document with the
 * variation merged into it — not the other way round. Pending edits are committed
 * to the variation on the way out (checkoutBranch's caller does that), so nothing
 * in progress is carried across by accident.
 *
 * Feed the result to completeMerge(), exactly as with a merge from the hub.
 *
 * @param {string} args.name  The variation to bring in.
 * @param {string} [args.into] The branch to bring it into. The lesson by default.
 * @returns {Promise<object|null>} The prepared merge, or null when the variation
 *          is already contained in the target — there is nothing to bring in.
 */
export async function prepareBranchMerge({ repoId, name, into = BRANCH, doc }) {
  const ctx = repoCtx(repoId);

  const theirs = await headOid({ ...ctx, ref: branchRef(name) });
  if (!theirs) throw new Error("That version no longer exists.");

  const ours = await headOid({ ...ctx, ref: branchRef(into) });
  // Already in: the lesson's history contains every commit the variation has, so
  // a merge would produce a commit that changes nothing.
  if (ours && (await contains({ ...ctx, oid: ours, ancestor: theirs }))) {
    return null;
  }
  return mergeAgainstCommit({ repoId, theirs, doc });
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

  // A fast-forward has nothing to record. Their history already contains ours and
  // we added nothing to it, so the merge is our branch moving to their commit —
  // and writing a merge commit instead would leave a permanent entry in the
  // lesson's timeline saying a decision was made when none was.
  //
  // The conflicts guard is belt and braces: mergeAgainstCommit can't produce both,
  // because a merge whose base is ours takes their side of everything. But the
  // flag arrives here from a prepared object the caller has held across a dialog,
  // and silently discarding somebody's conflict resolutions would be the worst
  // possible way to find out that assumption had stopped holding.
  if (prepared.fastForward && prepared.conflicts.length === 0) {
    await git.writeRef({
      ...ctx,
      ref: await currentBranchRef(ctx),
      value: prepared.theirs,
      force: true,
    });
    return doc;
  }

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

  if (status.needsMerge) {
    const prepared = await prepareMerge({
      repoId,
      lessonId,
      doc,
      ref: ORIGIN_REF,
      // The hub's copy of the branch we are on, which remoteStatus has just
      // resolved — not the lesson's tip, unless they are the same thing.
      theirs: status.theirs,
    });
    return { pushed: false, needsMerge: true, prepared, status };
  }

  const ctx = repoCtx(repoId);
  const packed = await packRepo(ctx);
  if (!packed) return { pushed: false, status }; // nothing committed yet

  // What the hub held when remoteStatus fetched a moment ago, which is what the
  // per-branch compare-and-swap is against. Read from the remote-tracking refs
  // that fetch wrote rather than kept in a variable, so it is the same answer the
  // objects in our store came with.
  const remote = status.hasRemote ? await remoteBranches(ctx) : {};
  const deleted = status.hasRemote ? await deletedBranches(ctx) : {};

  // "Nothing to do" is asked of the whole repository, not of the branch being
  // edited. Asking only about that one would strand the others: deleting a
  // variation, or merging one into the lesson from somewhere else, changes what
  // the hub should hold without moving the branch we happen to be standing on.
  const settled =
    Object.keys(deleted).length === 0 &&
    Object.keys(packed.refs).length === Object.keys(remote).length &&
    Object.entries(packed.refs).every(([name, oid]) => remote[name] === oid);
  if (settled) return { pushed: false, status };

  // Say what we believe about every branch we are touching. A branch we hold that
  // the hub doesn't gets "" — "I believe this is new" — which is the claim that
  // fails if somebody else created the same name in the meantime.
  const expected = {};
  for (const name of Object.keys(packed.refs))
    expected[name] = remote[name] || "";
  for (const [name, oid] of Object.entries(deleted)) expected[name] = oid;

  await pushPack(
    lessonId,
    {
      packfile: packed.packfile,
      head: packed.head,
      // The compare-and-swap for the lesson itself: null on a lesson with no
      // history yet, otherwise the tip we just confirmed we contain.
      parent: remote[BRANCH] || null,
      refs: packed.refs,
      expected,
      deletes: Object.keys(deleted),
    },
    accessToken,
  );

  // The deletions have landed, so stop asking for them. Only now: a marker
  // cleared before the push succeeded would leave a variation deleted here and
  // alive on the hub, ready to come back on the next device that clones.
  for (const name of Object.keys(deleted)) {
    await clearDeletedBranch({ ...ctx, name });
  }
  return { pushed: true, status };
}

/** The hub's branches as of our last fetch, from the remote-tracking refs. */
async function remoteBranches(ctx) {
  const names = await git
    .listRefs({ ...ctx, filepath: "refs/remotes/origin" })
    .catch(() => []);

  const out = {};
  for (const name of names) {
    const oid = await headOid({ ...ctx, ref: `refs/remotes/origin/${name}` });
    if (oid) out[name] = oid;
  }
  return out;
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
  // The lesson as this fork has it, and nothing else. A variation is an idea its
  // author is still turning over; offering it to somebody else to merge, unasked
  // and unmentioned, is not what "propose changes" means.
  const packed = await packRepo({ ...repoCtx(repoId), only: [BRANCH] });
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
 * What a proposal changes, and whether it would merge cleanly — computed without
 * an editor, so a proposal can be *read* on its own page.
 *
 * Merging a proposal needs the reviewer's editor, because the merge is theirs to
 * make and to push. Reading one doesn't, and the difference matters: the whole
 * queue was previously a list of titles nobody could look inside without opening
 * the lesson and starting a merge they might not want.
 *
 * Both packs are public exactly as far as the lesson is (a proposal is as
 * readable as what it targets), so this works for any viewer, signed in or not.
 * It answers two questions:
 *
 *   ops        what the proposer changed, as blocks, against the commit the two
 *              histories diverged at — a proposal's diff, in the same shape the
 *              history view renders
 *   conflicts  which blocks the lesson and the proposal have both changed in the
 *              same field, i.e. what a reviewer would actually have to decide
 *
 * Nothing is committed and no branch moves; the only writes are objects and a
 * remote-tracking ref, which is what indexing a pack means.
 *
 * @returns {Promise<null | { ops, conflicts, auto, base, ours, theirs, contained,
 *          hasLesson }>} null when the proposal's changes are no longer stored.
 */
export async function prepareProposalReview({
  repoId,
  lessonId,
  pullId,
  accessToken,
}) {
  const ctx = repoCtx(repoId);

  // The lesson's own history, so there is something to compare against. A lesson
  // with none (one written before version history) still gets a diff below — just
  // against nothing, which reads as "everything in it is new", and is true.
  const lessonPack = await fetchPack(lessonId).catch(() => null);
  if (lessonPack) {
    await fetchRemotePack({ ...ctx, ...lessonPack, ref: ORIGIN_REF });
  }

  const pack = await fetchPullPack(lessonId, pullId, accessToken);
  if (!pack) return null;
  await fetchRemotePack({ ...ctx, ...pack, ref: pullRef(pullId) });

  const theirs = pack.head;
  const ours = lessonPack?.head || null;

  const base = ours ? await mergeBase({ ...ctx, ours, theirs }) : null;
  // Already landed: every commit the proposal has is in the lesson's history.
  const contained = ours
    ? await contains({ ...ctx, oid: ours, ancestor: theirs })
    : false;

  const [baseDoc, ourDoc, theirDoc] = await Promise.all([
    base ? readDocAt({ ...ctx, oid: base }) : Promise.resolve(null),
    ours ? readDocAt({ ...ctx, oid: ours }) : Promise.resolve(null),
    readDocAt({ ...ctx, oid: theirs }),
  ]);

  // Against the merge base where there is one — that is a proposal's diff, and it
  // shows what the proposer did rather than every way the two now differ. Without
  // shared ancestry there is no such point, so fall back to the lesson as it
  // stands, which is the question a reader is really asking anyway.
  const ops = diffDocs(baseDoc || ourDoc, theirDoc);
  const merged = ourDoc ? mergeDocs(baseDoc, ourDoc, theirDoc) : null;

  return {
    ops,
    conflicts: merged?.conflicts || [],
    auto: merged?.auto || EMPTY_AUTO,
    base,
    ours,
    theirs,
    contained,
    hasLesson: Boolean(ours),
  };
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
  // The lesson, and only the lesson. Its author's variations came down in the same
  // pack — they are in it so that *they* can reach them from another device — but
  // somebody else's half-finished ideas are not part of what was forked, and
  // adopting them as branches of the fork would say they were.
  await cloneFromPack({ ...ctx, ...pack, refs: null });

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
