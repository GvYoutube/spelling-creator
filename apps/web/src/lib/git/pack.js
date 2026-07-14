// Moving a lesson's repository between people — the machinery behind
// "forking is cloning".
//
// A lesson's history lives in the browser, so for someone else to fork it the
// objects have to travel. We send them the way git itself does: as a **packfile**
// — every object reachable from the lesson's branch, compressed into one blob —
// plus the refs that point into it. The Worker stores that pair in R2 (see
// apps/api/src/routes/git.js); a forker downloads it, indexes it into their own
// object store, and now holds a genuine clone: the same commits, the same oids,
// the same ancestry.
//
// That shared ancestry is the whole payoff. Because the fork's history and the
// original's descend from commits with identical oids, git can find their merge
// base — which is what lets merge.js do a real *three*-way merge (base/ours/
// theirs) later on, instead of guessing at two.
//
// Lesson images are NOT in the pack. Blocks reference images by content hash and
// the bytes live in R2 already (see lib/imageStore.js and the /images routes), so
// a pack is pure JSON and stays small.

import * as git from "isomorphic-git";
import { BRANCH_REF, UPSTREAM_REF, ensureRepo, headOid } from "./repo.js";

/**
 * Every object reachable from a commit: the commit itself, its ancestors, and
 * all of their trees and blobs.
 *
 * A packfile has to be self-contained — an object referenced but not included
 * makes the pack unindexable on the far side — so we walk the whole graph rather
 * than just the tip. Objects are deduped by oid, which is also why a fork's pack
 * doesn't re-send history the receiver already has: identical content has an
 * identical oid.
 */
export async function reachableOids({ fs, gitdir, oid }) {
  const oids = new Set();
  const commits = [oid];

  while (commits.length > 0) {
    const commitOid = commits.pop();
    if (oids.has(commitOid)) continue;
    oids.add(commitOid);

    const { commit } = await git.readCommit({ fs, gitdir, oid: commitOid });
    await collectTree({ fs, gitdir, oid: commit.tree, oids });
    for (const parent of commit.parent) {
      if (!oids.has(parent)) commits.push(parent);
    }
  }

  return [...oids];
}

async function collectTree({ fs, gitdir, oid, oids }) {
  if (oids.has(oid)) return; // shared subtree — already packed
  oids.add(oid);

  const { tree } = await git.readTree({ fs, gitdir, oid });
  for (const entry of tree) {
    if (entry.type === "tree") {
      await collectTree({ fs, gitdir, oid: entry.oid, oids });
    } else if (!oids.has(entry.oid)) {
      oids.add(entry.oid); // a blob: one block, or the manifest
    }
  }
}

/**
 * Pack the lesson's whole history for upload.
 * @returns {Promise<{ packfile: Uint8Array, filename: string, head: string, refs: object } | null>}
 *          null when the repo has no commits to send.
 */
export async function packRepo({ fs, gitdir }) {
  const head = await headOid({ fs, gitdir });
  if (!head) return null;

  const oids = await reachableOids({ fs, gitdir, oid: head });
  const { packfile, filename } = await git.packObjects({
    fs,
    gitdir,
    oids,
    write: false,
  });

  return { packfile, filename, head, refs: { [BRANCH_REF]: head } };
}

/**
 * Index a downloaded packfile into a repo's object store.
 *
 * The pack is written under objects/pack/ with the filename git expects
 * (pack-<sha>.pack) and indexed in place, which is what makes its objects
 * readable — a .pack without its .idx is inert.
 */
async function absorbPack({ fs, gitdir, packfile, filename }) {
  const dir = `${gitdir}/objects/pack`;
  await mkdirp(fs, dir);

  const name = filename || `pack-${crypto.randomUUID().replace(/-/g, "")}.pack`;
  await fs.promises.writeFile(`${dir}/${name}`, packfile);

  // indexPack joins dir + filepath, so pointing `dir` at the gitdir puts the
  // .idx next to the .pack, where git looks for it.
  await git.indexPack({
    fs,
    dir: gitdir,
    gitdir,
    filepath: `objects/pack/${name}`,
  });
}

/**
 * Clone a downloaded pack into a fresh repository. This is what forking does.
 *
 * The result is a real clone: same commits, same oids, full history, and a
 * common ancestor with the lesson it came from — so the fork can later be merged
 * back (or pull the original's changes in) with a true three-way merge.
 */
export async function cloneFromPack({ fs, gitdir, packfile, filename, head }) {
  await ensureRepo({ fs, gitdir });
  await absorbPack({ fs, gitdir, packfile, filename });

  await git.writeRef({ fs, gitdir, ref: BRANCH_REF, value: head, force: true });
  await git.writeRef({
    fs,
    gitdir,
    ref: "HEAD",
    value: BRANCH_REF,
    force: true,
    symbolic: true,
  });
  return head;
}

/**
 * Fetch a remote lesson's history into this repo, recording its tip at `ref`.
 *
 * The objects land in the same store as ours, so the commits the two histories
 * share are literally the same objects — findMergeBase can then walk both back to
 * their common ancestor. That ancestor is the `base` merge.js needs.
 *
 * `ref` says *which* remote this is: UPSTREAM_REF for the lesson we forked from,
 * ORIGIN_REF for this lesson's own published history (which a trusted
 * collaborator may have moved on without us).
 */
export async function fetchRemotePack({
  fs,
  gitdir,
  packfile,
  filename,
  head,
  ref = UPSTREAM_REF,
}) {
  await ensureRepo({ fs, gitdir });
  await absorbPack({ fs, gitdir, packfile, filename });
  await git.writeRef({ fs, gitdir, ref, value: head, force: true });
  return head;
}

/** Whether `oid` has `ancestor` somewhere in its history (so it contains it). */
export async function contains({ fs, gitdir, oid, ancestor }) {
  if (oid === ancestor) return true;
  try {
    return await git.isDescendent({ fs, gitdir, oid, ancestor });
  } catch {
    return false; // unrelated histories, or an object we don't hold
  }
}

/**
 * The commit both branches descend from, or null if they share no ancestry
 * (which happens when a lesson was forked before it had a repo — there, merging
 * degrades to a two-way compare, with `base` null).
 */
export async function mergeBase({ fs, gitdir, ours, theirs }) {
  try {
    const bases = await git.findMergeBase({ fs, gitdir, oids: [ours, theirs] });
    return bases[0] || null;
  } catch {
    return null;
  }
}

async function mkdirp(fs, path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      await fs.promises.mkdir(current);
    } catch {
      // Already there, which is the normal case for objects/ — keep going.
    }
  }
}
