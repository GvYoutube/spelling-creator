// Forking and merging, orchestrated.
//
// Forking a lesson clones its repository. Merging compares block ids against the
// commit the two histories share. These are the two flows that make the version
// control worth having, and they're both a handful of calls over the primitives
// in repo.js / pack.js / merge.js.
//
// The one thing to understand here: a fork keeps a *pointer home*. The hub row
// records `forkedFrom`, and the fork's repo keeps the original's tip at
// refs/remotes/upstream/main. Together those let the fork later ask "what has the
// original changed since I left?" and get a real answer — the merge base — rather
// than having to guess.

import * as git from "isomorphic-git";
import { newId } from "../id.js";
import { preserveLocalFields } from "./doc.js";
import { DRAFT_REPO, copyRepo, deleteRepo, repoCtx } from "./fs.js";
import { applyResolutions, mergeDocs } from "./merge.js";
import {
  cloneFromPack,
  fetchUpstreamPack,
  mergeBase,
  packRepo,
} from "./pack.js";
import { fetchPack, pushPack } from "./remote.js";
import { UPSTREAM_REF, commitDoc, headOid, readDocAt } from "./repo.js";

/**
 * Publish a lesson's history: pack every object reachable from its branch and
 * upload it, so anyone who forks the lesson clones a real repository.
 *
 * Called after the lesson itself has been saved through /lessons. A failure is
 * the caller's to swallow — the lesson is already saved; only its history didn't
 * make it, and the next save will carry it.
 */
export async function publishHistory(lessonId, accessToken) {
  const packed = await packRepo(repoCtx(lessonId));
  if (!packed) return false; // nothing committed yet
  await pushPack(
    lessonId,
    { packfile: packed.packfile, head: packed.head },
    accessToken,
  );
  return true;
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

  // Record where we came from, so the first "sync with original" has a base even
  // before it fetches anything new.
  await fetchUpstreamPack({ ...ctx, ...pack });

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

  // Where we forked from, so the first sync has a base even before it fetches.
  const ctx = repoCtx(DRAFT_REPO);
  const head = await headOid(ctx);
  if (head) {
    await git.writeRef({ ...ctx, ref: UPSTREAM_REF, value: head, force: true });
  }
  return true;
}

/**
 * Work out what merging the original lesson into this fork would do.
 *
 * Fetches the original's current history into *our* repo (its objects join ours;
 * the commits we already share are literally the same objects), finds the commit
 * the two histories diverged from, and merges the three docs by block id.
 *
 * Nothing is committed — this is the "what would happen" step, so the editor can
 * put any conflicts to the user first. Pass the result to completeMerge().
 *
 * @returns {Promise<null | {
 *   doc, conflicts, auto, ours, theirs, base, upToDate
 * }>} null when the original has no published history to merge.
 */
export async function prepareUpstreamMerge({ repoId, upstreamLessonId, doc }) {
  const ctx = repoCtx(repoId);

  const pack = await fetchPack(upstreamLessonId).catch(() => null);
  if (!pack) return null;

  await fetchUpstreamPack({ ...ctx, ...pack });

  const ours = await headOid(ctx);
  const theirs = pack.head;
  if (!ours) return null;

  // Their tip is already in our history: we have everything they do.
  if (ours === theirs) return { upToDate: true };
  const base = await mergeBase({ ...ctx, ours, theirs });
  if (base === theirs) return { upToDate: true };

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
    upToDate: false,
  };
}

/**
 * Finish a merge once the user has settled any conflicts, recording it as a
 * commit with *two* parents — ours and theirs. That's what joins the two
 * histories, so a later merge can find this point as its base.
 *
 * @param {object} prepared  The result of prepareUpstreamMerge.
 * @param {Record<string, "ours"|"theirs"|"both">} choices  Keyed by block id.
 * @returns {Promise<object>} The merged doc, as committed.
 */
export async function completeMerge({
  repoId,
  prepared,
  choices = {},
  author,
  upstreamTitle,
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

  const summary = mergeSummary(prepared, choices, upstreamTitle);
  await commitDoc({
    ...ctx,
    doc,
    author,
    message: summary,
    parents: [prepared.ours, prepared.theirs],
  });

  return doc;
}

function mergeSummary(prepared, choices, upstreamTitle) {
  const name = upstreamTitle ? `"${upstreamTitle}"` : "the original lesson";
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
