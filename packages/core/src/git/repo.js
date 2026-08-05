// A lesson's git repository: create it, commit the doc into it, read history
// back out, and diff any two commits by block id.
//
// The repo is **bare** — there is no working directory and no index. We go
// straight to plumbing: writeBlob -> writeTree -> writeCommit -> writeRef. A
// browser editor has no use for checked-out files (the doc lives in React state
// and IndexedDB), and skipping the worktree means a commit costs one blob write
// per *changed* block rather than a filesystem sync of the whole lesson.
//
// Everything takes `{ fs, gitdir }` so it runs unchanged against LightningFS in
// the browser and node:fs in tests. See fs.js for the browser binding.

import * as git from "isomorphic-git";
import {
  readBlockOids,
  readDocTree,
  readManifest,
  writeDocTree,
} from "./layout.js";
import { describeOps, diffDocs } from "./ops.js";

export const BRANCH = "main";
export const BRANCH_REF = `refs/heads/${BRANCH}`;

// The two remotes a lesson can have, in git's own vocabulary.
//
//   origin    this lesson's own published history — what the hub holds for it.
//             It can be *ahead of us* now that a trusted collaborator may merge
//             their fork into it, so we check it before pushing.
//   upstream  the lesson this one was forked FROM, for pulling its later changes
//             in (and, if we're trusted, for merging ours back into it).
export const ORIGIN_REF = "refs/remotes/origin/main";
export const UPSTREAM_REF = "refs/remotes/upstream/main";

const DEFAULT_AUTHOR = { name: "Spelling Creator", email: "lessons@local" };

/** The signature to stamp commits with, derived from the signed-in user. */
export function authorFrom(identity) {
  const name = (identity?.name || "").trim();
  const email = (identity?.email || "").trim();
  if (!name && !email) return DEFAULT_AUTHOR;
  return {
    name: name || email,
    email: email || DEFAULT_AUTHOR.email,
  };
}

/** Create the repository if it isn't there yet. Safe to call on every open. */
export async function ensureRepo({ fs, gitdir }) {
  if (await exists(fs, `${gitdir}/config`)) return;
  await git.init({ fs, gitdir, bare: true, defaultBranch: BRANCH });
}

async function exists(fs, path) {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The current head commit oid, or null in a repo with no commits yet. */
export async function headOid({ fs, gitdir }) {
  try {
    return await git.resolveRef({ fs, gitdir, ref: BRANCH_REF });
  } catch {
    return null;
  }
}

/** The tree oid of a commit. */
export async function treeOfCommit({ fs, gitdir, oid }) {
  const { commit } = await git.readCommit({ fs, gitdir, oid });
  return commit.tree;
}

/** The doc as it stood at a given commit. */
export async function readDocAt({ fs, gitdir, oid }) {
  const treeOid = await treeOfCommit({ fs, gitdir, oid });
  return readDocTree({ fs, gitdir, treeOid });
}

/** The doc at HEAD, or null when the repo has no commits yet. */
export async function readHeadDoc({ fs, gitdir }) {
  const head = await headOid({ fs, gitdir });
  if (!head) return null;
  return readDocAt({ fs, gitdir, oid: head });
}

/**
 * Commit a document — but only if it actually differs from HEAD.
 *
 * The no-op check is exact and nearly free: we write the doc's tree (blobs for
 * unchanged blocks resolve to oids git already has) and compare the resulting
 * tree oid with HEAD's. Equal trees mean equal content, because git addresses
 * content by hash. So the periodic autocommit can fire as often as it likes and
 * a lesson that hasn't changed never gains an empty commit.
 *
 * @param {object}   args.doc       The document to commit.
 * @param {object}   [args.author]  { name, email } — defaults to a generic signature.
 * @param {string}   [args.message] Overrides the message derived from the ops.
 * @param {string[]} [args.parents] Overrides the parents (a merge passes two).
 * @returns {Promise<{ oid: string, ops: object[] } | null>} null when there was
 *          nothing to commit.
 */
export async function commitDoc({ fs, gitdir, doc, author, message, parents }) {
  await ensureRepo({ fs, gitdir });

  const treeOid = await writeDocTree({ fs, gitdir, doc });
  const head = await headOid({ fs, gitdir });

  // Derive the ops from the previous commit's doc so the message describes what
  // this commit actually changed, rather than what the editor happened to touch
  // since the last autosave.
  const previous = head ? await readDocAt({ fs, gitdir, oid: head }) : null;
  const ops = diffDocs(previous, doc);

  const explicitParents = Array.isArray(parents);
  if (!explicitParents && head) {
    const headTree = await treeOfCommit({ fs, gitdir, oid: head });
    if (headTree === treeOid) return null; // nothing changed
  }

  const signature = {
    ...authorFrom(author),
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: new Date().getTimezoneOffset(),
  };

  const parentOids = explicitParents ? parents : head ? [head] : [];
  const oid = await git.writeCommit({
    fs,
    gitdir,
    commit: {
      tree: treeOid,
      parent: parentOids,
      author: signature,
      committer: signature,
      message:
        message || (ops.length ? describeOps(ops) : "Update the lesson\n"),
    },
  });

  await git.writeRef({
    fs,
    gitdir,
    ref: BRANCH_REF,
    value: oid,
    force: true,
  });

  return { oid, ops };
}

/**
 * The lesson's history, newest first.
 * @returns {Promise<Array<{ oid, message, summary, author, timestamp, parents, isMerge }>>}
 */
export async function history({ fs, gitdir, depth = 100 }) {
  const head = await headOid({ fs, gitdir });
  if (!head) return [];

  const commits = await git.log({ fs, gitdir, ref: BRANCH_REF, depth });
  return commits.map(({ oid, commit }) => ({
    oid,
    message: commit.message,
    summary: commit.message.split("\n")[0].trim(),
    author: commit.author.name,
    timestamp: commit.author.timestamp * 1000,
    parents: commit.parent,
    isMerge: commit.parent.length > 1,
  }));
}

/**
 * Diff two commits **by block id**, straight off their trees.
 *
 * No block content is parsed for added/removed/changed: a block's blob oid is a
 * hash of its canonical JSON, so "changed" is just "same id, different oid".
 * Content is only read for `block.edit`, to name the fields that differ, and for
 * moves, which are read out of the two manifests.
 *
 * @param {string|null} fromOid  The older commit (null = the empty tree, i.e. the root commit).
 * @param {string}      toOid    The newer commit.
 * @returns {Promise<object[]>} ops, in the same shape diffDocs produces.
 */
export async function diffCommits({ fs, gitdir, fromOid, toOid }) {
  const before = fromOid ? await readDocAt({ fs, gitdir, oid: fromOid }) : null;
  const after = await readDocAt({ fs, gitdir, oid: toOid });
  return diffDocs(before, after);
}

/**
 * What a commit changed, against its first parent. For a merge commit that reads
 * as "what this merge brought in, relative to our side". The root commit has no
 * parent, so it diffs against nothing and reads as the lesson's starting state.
 */
export async function diffFromParent({ fs, gitdir, oid }) {
  const { commit } = await git.readCommit({ fs, gitdir, oid });
  return diffCommits({
    fs,
    gitdir,
    fromOid: commit.parent[0] || null,
    toOid: oid,
  });
}

/**
 * The block ids whose content differs between two commits, plus which were added
 * and removed — computed from tree entries alone (one readTree per side, no blob
 * reads). This is the cheap path the history list uses to badge each commit.
 */
export async function changedBlockIds({ fs, gitdir, fromOid, toOid }) {
  const after = await readBlockOids({
    fs,
    gitdir,
    treeOid: await treeOfCommit({ fs, gitdir, oid: toOid }),
  });
  const before = fromOid
    ? await readBlockOids({
        fs,
        gitdir,
        treeOid: await treeOfCommit({ fs, gitdir, oid: fromOid }),
      })
    : new Map();

  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, oid] of after) {
    if (!before.has(id)) added.push(id);
    else if (before.get(id) !== oid) changed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, removed, changed };
}

/**
 * Restore the lesson to an earlier commit by committing that commit's tree
 * again on top of HEAD.
 *
 * History is never rewritten: "restore" is an ordinary forward commit whose tree
 * happens to equal an older one, so the versions you restored *from* stay in the
 * timeline and the restore itself can be undone by restoring again. Returns the
 * restored doc so the editor can adopt it.
 */
export async function restoreCommit({ fs, gitdir, oid, author }) {
  const doc = await readDocAt({ fs, gitdir, oid });
  const manifest = await readManifest({
    fs,
    gitdir,
    treeOid: await treeOfCommit({ fs, gitdir, oid }),
  });

  const short = oid.slice(0, 7);
  const result = await commitDoc({
    fs,
    gitdir,
    doc,
    author,
    message: `Restore the version from ${short}\n\nRestores "${manifest.title}" as it stood at ${short}.\n`,
  });

  // commitDoc returns null when the tree already matches HEAD — restoring the
  // version you're already on is a no-op, not an error.
  return { doc, oid: result?.oid || oid, restored: Boolean(result) };
}

/** Whether the working doc differs from what's committed at HEAD. */
export async function pendingOps({ fs, gitdir, doc }) {
  const head = await headOid({ fs, gitdir });
  const committed = head ? await readDocAt({ fs, gitdir, oid: head }) : null;
  return diffDocs(committed, doc);
}
