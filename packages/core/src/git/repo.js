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
import { DEFAULT_BRANCH, isBranchName } from "./refs.js";

// The branch a lesson *is*. A lesson can hold several — see the block below —
// but exactly one of them is what the hub publishes, what a reader sees, and
// what a fork clones, and this is it.
export const BRANCH = DEFAULT_BRANCH;
export const BRANCH_REF = `refs/heads/${BRANCH}`;

// ---- More than one branch ---------------------------------------------------
//
// A lesson's repository holds a branch per *variation*: an alternative version of
// the lesson its author is trying out, kept apart from the one people are reading.
// The default branch is the lesson; the rest are drafts of what it might become.
//
// Which one is being edited is recorded the way git records it — HEAD, a symbolic
// ref pointing at a branch — rather than as state beside the repository. That
// matters for more than tidiness: HEAD is inside the gitdir, so it survives the
// copy that publishes a draft (adoptDraftRepo) and the copy that forks a lesson
// locally (copyRepo), neither of which knows anything about branches.
export const HEADS_PREFIX = "refs/heads/";

/** The full ref for a branch name. */
export const branchRef = (name) => `${HEADS_PREFIX}${name}`;

/** The branch name in a full ref, or the ref unchanged if it isn't one. */
export const branchNameOf = (ref) =>
  ref?.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;

// A branch the author deleted, remembered until the deletion has been pushed.
//
// Without this a delete would not travel: a push sends the branches we hold, and
// a branch we no longer hold is indistinguishable from one another device added
// while we weren't looking — which must be kept, not dropped. So a delete leaves
// a marker naming what it removed, the next push turns that into an explicit
// instruction, and only then is the marker cleared.
const DELETED_PREFIX = "refs/deleted/";

// The two remotes a lesson can have, in git's own vocabulary.
//
//   origin    this lesson's own published history — what the hub holds for it.
//             It can be *ahead of us*, since a trusted collaborator may have
//             saved it (or merged a pull request into it) since we last looked,
//             so we check it before pushing.
//   upstream  the lesson this one was forked FROM, for pulling its later changes
//             in — and for opening a pull request against it.
export const ORIGIN_REF = "refs/remotes/origin/main";
export const UPSTREAM_REF = "refs/remotes/upstream/main";

/**
 * The ref a pull request's proposed history is fetched into while it's being
 * reviewed. One per request, so two open proposals on the same lesson never
 * overwrite each other's tip.
 */
export const pullRef = (pullId) => `refs/remotes/pull/${pullId}`;

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

/**
 * The branch being edited, read from HEAD.
 *
 * Falls back to the default branch, which covers a repository written before
 * HEAD was anything but decorative as well as the moment before the first commit
 * exists.
 */
export async function currentBranch({ fs, gitdir }) {
  try {
    const name = await git.currentBranch({ fs, gitdir, fullname: false });
    return name && isBranchName(name) ? name : BRANCH;
  } catch {
    return BRANCH;
  }
}

/** The ref HEAD points at — what a commit will move. */
export async function currentBranchRef(ctx) {
  return branchRef(await currentBranch(ctx));
}

/**
 * The head commit oid, or null when there is nothing there yet.
 *
 * With no `ref` this answers for the branch being edited, which is what almost
 * every caller means. Pass one to ask about a particular branch.
 */
export async function headOid({ fs, gitdir, ref }) {
  try {
    return await git.resolveRef({
      fs,
      gitdir,
      ref: ref || (await currentBranchRef({ fs, gitdir })),
    });
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

  // Whatever HEAD points at — the lesson itself, or the variation being tried
  // out. Resolved once, so a commit and the ref it moves can't disagree.
  const ref = await currentBranchRef({ fs, gitdir });

  const treeOid = await writeDocTree({ fs, gitdir, doc });
  const head = await headOid({ fs, gitdir, ref });

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

  await git.writeRef({ fs, gitdir, ref, value: oid, force: true });

  return { oid, ops };
}

/**
 * The lesson's history, newest first.
 *
 * `ref` defaults to the branch being edited, which is what the editor wants: the
 * repository it is committing to. A reader wants the *published* history
 * instead, and those are not the same thing — a lesson open in the editor has
 * local commits that were never pushed. So a caller may pass any ref or oid,
 * and the public lesson page passes the published head (see LessonHistory.jsx).
 *
 * @returns {Promise<Array<{ oid, message, summary, author, timestamp, parents, isMerge }>>}
 */
export async function history({ fs, gitdir, depth = 100, ref }) {
  // Only the implicit case needs the "is there anything here yet" guard: an
  // explicit oid a caller handed us says nothing about whether HEAD resolves.
  const target = ref || (await currentBranchRef({ fs, gitdir }));
  if (!ref && !(await headOid({ fs, gitdir, ref: target }))) return [];

  const commits = await git.log({ fs, gitdir, ref: target, depth });
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

// ---- Branches ---------------------------------------------------------------

/**
 * Every branch in the repository, with the one being edited marked.
 *
 * `ahead` is how many commits this branch has that the default branch doesn't —
 * which is the only number about a variation anybody actually wants: how much
 * work is sitting on it. The default branch's own `ahead` is 0 by definition.
 *
 * @returns {Promise<Array<{ name, ref, oid, isDefault, isCurrent, ahead }>>}
 */
export async function listBranches({ fs, gitdir, depth = 200 }) {
  const [names, current] = await Promise.all([
    git.listBranches({ fs, gitdir }).catch(() => []),
    currentBranch({ fs, gitdir }),
  ]);

  // A repository with no commits has no branch files yet, but it is still "on"
  // a branch — HEAD says so — and the editor has to be able to show it.
  const all = names.includes(current) ? names : [...names, current];
  const defaultOid = await headOid({ fs, gitdir, ref: BRANCH_REF });

  return Promise.all(
    all.sort(sortBranches).map(async (name) => {
      const oid = await headOid({ fs, gitdir, ref: branchRef(name) });
      return {
        name,
        ref: branchRef(name),
        oid,
        isDefault: name === BRANCH,
        isCurrent: name === current,
        ahead:
          name === BRANCH || !oid
            ? 0
            : await aheadCount({
                fs,
                gitdir,
                ours: oid,
                theirs: defaultOid,
                depth,
              }),
      };
    }),
  );
}

// The lesson first, then the variations alphabetically. The default branch is not
// one variation among others — it is the thing they are variations of.
function sortBranches(a, b) {
  if (a === BRANCH) return -1;
  if (b === BRANCH) return 1;
  return a.localeCompare(b);
}

/**
 * How many commits `ours` has that `theirs` does not.
 *
 * Bounded by `depth` on both sides, because this is drawn in a menu and an exact
 * answer for a very long history is worth less than a fast one. A branch that has
 * outrun the window reports the window, which reads as "a lot" and is true.
 */
export async function aheadCount({ fs, gitdir, ours, theirs, depth = 200 }) {
  if (!ours || ours === theirs) return 0;
  if (!theirs) {
    const log = await git.log({ fs, gitdir, ref: ours, depth }).catch(() => []);
    return log.length;
  }

  const [oursLog, theirsLog] = await Promise.all([
    git.log({ fs, gitdir, ref: ours, depth }).catch(() => []),
    git.log({ fs, gitdir, ref: theirs, depth }).catch(() => []),
  ]);
  const shared = new Set(theirsLog.map((c) => c.oid));
  return oursLog.filter((c) => !shared.has(c.oid)).length;
}

/**
 * Start a new branch at a commit — by default wherever we are now, which is what
 * "try something different from here" means.
 *
 * Refuses to overwrite an existing branch: the caller asked to create one, and
 * silently moving somebody's work somewhere else is not a version of that.
 */
export async function createBranch({ fs, gitdir, name, from }) {
  if (!isBranchName(name)) throw new Error("That name can't be used.");

  const ref = branchRef(name);
  if (await headOid({ fs, gitdir, ref })) {
    throw new Error("There is already one with that name.");
  }

  const oid = from || (await headOid({ fs, gitdir }));
  // A branch has to point at something. Before the first commit there is nothing
  // to point at, so there is nothing to branch from either.
  if (!oid) throw new Error("There is nothing to base it on yet.");

  await git.writeRef({ fs, gitdir, ref, value: oid, force: false });
  // Creating a variation and then not being on it is never what was meant.
  await checkoutBranch({ fs, gitdir, name });
  return { name, ref, oid };
}

/**
 * Switch to a branch, and hand back the document as it stands there.
 *
 * This is a checkout in the only sense a bare repository has one: HEAD moves, and
 * the caller adopts the document at the new tip. There is no working tree to
 * update and no uncommitted state to carry over — the editor commits on a pause,
 * so anything worth keeping is already a commit on the branch being left.
 *
 * @returns {Promise<{ name, oid, doc }>} `doc` is null on a branch with no commits.
 */
export async function checkoutBranch({ fs, gitdir, name }) {
  if (!isBranchName(name)) throw new Error("That name can't be used.");

  const ref = branchRef(name);
  const oid = await headOid({ fs, gitdir, ref });
  if (!oid && name !== BRANCH)
    throw new Error("That version no longer exists.");

  await git.writeRef({
    fs,
    gitdir,
    ref: "HEAD",
    value: ref,
    force: true,
    symbolic: true,
  });
  return { name, oid, doc: oid ? await readDocAt({ fs, gitdir, oid }) : null };
}

/**
 * Rename a branch, moving HEAD with it when it is the one being edited.
 *
 * Write the new ref before removing the old one: interrupted the other way round
 * the branch would be gone and its commits unreachable, and interrupted this way
 * the worst case is a duplicate the author can delete.
 */
export async function renameBranch({ fs, gitdir, from, to }) {
  if (from === BRANCH)
    throw new Error("The lesson itself can't be renamed here.");
  if (!isBranchName(to)) throw new Error("That name can't be used.");
  if (from === to) return { name: to };

  const oid = await headOid({ fs, gitdir, ref: branchRef(from) });
  if (!oid) throw new Error("That version no longer exists.");
  if (await headOid({ fs, gitdir, ref: branchRef(to) })) {
    throw new Error("There is already one with that name.");
  }

  await git.writeRef({
    fs,
    gitdir,
    ref: branchRef(to),
    value: oid,
    force: false,
  });
  const wasCurrent = (await currentBranch({ fs, gitdir })) === from;
  if (wasCurrent) await checkoutBranch({ fs, gitdir, name: to });
  await git.deleteRef({ fs, gitdir, ref: branchRef(from) });

  // The rename reaches the hub as a delete of the old name plus the new branch,
  // which is what it is: refs have no identity of their own to carry across.
  await markDeleted({ fs, gitdir, name: from, oid });
  return { name: to, oid };
}

/**
 * Delete a branch, leaving behind the marker that will carry the deletion to the
 * hub on the next push (see DELETED_PREFIX above).
 *
 * The default branch can't go — it is the lesson — and neither can the one being
 * edited, because there would then be no answer to "what am I looking at".
 */
export async function deleteBranch({ fs, gitdir, name }) {
  if (name === BRANCH) throw new Error("The lesson itself can't be deleted.");
  if ((await currentBranch({ fs, gitdir })) === name) {
    throw new Error("Switch to another version before deleting this one.");
  }

  const oid = await headOid({ fs, gitdir, ref: branchRef(name) });
  if (!oid) return false;

  await git.deleteRef({ fs, gitdir, ref: branchRef(name) });
  await markDeleted({ fs, gitdir, name, oid });
  return true;
}

async function markDeleted({ fs, gitdir, name, oid }) {
  await git.writeRef({
    fs,
    gitdir,
    ref: `${DELETED_PREFIX}${name}`,
    value: oid,
    force: true,
  });
}

/**
 * The branches deleted here that the hub may not know about yet, as
 * `{ name: theOidItPointedAt }` — the oid being what the deletion is compared and
 * swapped against, so a push can't remove work somebody else put on that name in
 * the meantime.
 */
export async function deletedBranches({ fs, gitdir }) {
  const refs = await git
    .listRefs({ fs, gitdir, filepath: DELETED_PREFIX.replace(/\/$/, "") })
    .catch(() => []);

  const out = {};
  for (const name of refs) {
    if (!isBranchName(name)) continue;
    const oid = await headOid({ fs, gitdir, ref: `${DELETED_PREFIX}${name}` });
    if (oid) out[name] = oid;
  }
  return out;
}

/** Forget a deletion, once the hub has been told about it. */
export async function clearDeletedBranch({ fs, gitdir, name }) {
  await git
    .deleteRef({ fs, gitdir, ref: `${DELETED_PREFIX}${name}` })
    .catch(() => {});
}
