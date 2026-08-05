// Forking, merging, and pushing — orchestrated.
//
// Forking a lesson clones its repository. Merging compares block ids against the
// commit the two histories share. Pushing sends a history back to the hub. These
// are the flows that make the version control worth having, and they're all a
// handful of calls over the primitives in repo.js / pack.js / merge.js.
//
// Two things to understand here.
//
// 1. A fork keeps a *pointer home*. The hub row records `forkedFrom`, and the
//    fork's repo keeps the original's tip at refs/remotes/upstream/main. Together
//    those let the fork ask "what has the original changed since I left?" and get
//    a real answer — the merge base — rather than having to guess.
//
// 2. A lesson can have more than one writer. Its author can save it, and so can a
//    trusted collaborator merging a fork back in. So *nobody pushes blind*: before
//    sending a history we compare it with what the hub actually holds
//    (remoteStatus), and we only push a history that already contains that. If the
//    lesson has moved on beneath us, the push is refused (by us here, and by the
//    Worker's compare-and-swap regardless) and the changes are merged first.
//    Without that, whoever saved second would quietly erase the other's work.

import * as git from "isomorphic-git";
import { newId } from "@spelling-creator/core/id";
import { preserveLocalFields } from "@spelling-creator/core/git/doc";
import { DRAFT_REPO, copyRepo, deleteRepo, repoCtx } from "./fs.js";
import { applyResolutions, mergeDocs } from "@spelling-creator/core/git/merge";
import {
  cloneFromPack,
  contains,
  fetchRemotePack,
  mergeBase,
  packRepo,
} from "@spelling-creator/core/git/pack";
import { fetchPack, pushPack } from "@spelling-creator/core/git/remote";
import {
  ORIGIN_REF,
  UPSTREAM_REF,
  commitDoc,
  headOid,
  readDocAt,
} from "@spelling-creator/core/git/repo";

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
  const ctx = repoCtx(repoId);

  const pack = await fetchPack(lessonId).catch(() => null);
  if (!pack) return null;

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
 * Merge this fork back into the lesson it came from — the trusted-collaborator
 * contribution.
 *
 * By the time this runs, the original's history has already been merged into ours
 * (prepareMerge + completeMerge, or `ahead` because we were already on top of it),
 * so our head *contains* the original's tip. Pushing it therefore only ever moves
 * the original forward — it can't erase the author's commits.
 *
 * The Worker enforces this independently: it checks we're a trusted collaborator,
 * and compare-and-swaps on `parent`. If the original moved between our merge and
 * this push, the push is rejected and the caller re-runs the flow.
 *
 * Only the *history* is pushed here. The lesson's document row is written by the
 * caller (lib/lessons.js updateLesson), because that's the hub's business, not
 * git's — and it must happen after this succeeds, never before.
 */
export async function pushToUpstream({
  repoId,
  upstreamLessonId,
  expectedHead,
  accessToken,
}) {
  const packed = await packRepo(repoCtx(repoId));
  if (!packed) throw new Error("There is nothing to merge back yet.");

  await pushPack(
    upstreamLessonId,
    {
      packfile: packed.packfile,
      head: packed.head,
      parent: expectedHead,
    },
    accessToken,
  );
  return packed.head;
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
