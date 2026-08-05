// The browser filesystem the lesson repositories live on.
//
// isomorphic-git needs a filesystem; browsers don't have one. LightningFS gives
// it an IndexedDB-backed POSIX-ish fs, in its own database — separate from the
// `s2c-lesson-maker` store that holds the working doc and image blobs (see
// imageStore.js), so a repo can never collide with a lesson image.
//
// One repository per lesson, bare (no working tree — see repo.js):
//
//   /lessons/<repoId>/.git      the object store, refs and config
//
// `repoId` is the hub lesson's id once it has one, and DRAFT_REPO while the
// lesson is still an unattached local draft. Publishing a draft copies its repo
// under the new lesson id (adoptDraftRepo), so the history a user built up
// before they first published isn't thrown away.

import LightningFS from "@isomorphic-git/lightning-fs";
import { DRAFT_REPO } from "@spelling-creator/core/git/doc";

const DB_NAME = "s2c-lesson-git";
const ROOT = "/lessons";

export { DRAFT_REPO };

let fsInstance = null;

/** The LightningFS instance, created on first use. */
export function gitFs() {
  if (!fsInstance) fsInstance = new LightningFS(DB_NAME);
  return fsInstance;
}

/** `{ fs, gitdir }` — the context every function in repo.js/pack.js takes. */
export function repoCtx(repoId) {
  return { fs: gitFs(), gitdir: `${ROOT}/${repoId}/.git` };
}

async function exists(fs, path) {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether a repository already exists locally for this lesson. */
export async function repoExists(repoId) {
  const { fs, gitdir } = repoCtx(repoId);
  return exists(fs, `${gitdir}/config`);
}

/**
 * Copy the draft repo to a published lesson's id, then drop the draft.
 *
 * Called the first time a lesson is saved to the cloud: the user may have been
 * editing (and accumulating history) for an hour before they hit Publish, and
 * that history is theirs. Copying the object store is a legitimate clone — git
 * objects are immutable and content-addressed, so the copy is byte-identical and
 * every commit oid survives.
 */
export async function adoptDraftRepo(lessonId) {
  if (!lessonId || lessonId === DRAFT_REPO) return;
  const fs = gitFs();
  if (!(await exists(fs, `${ROOT}/${DRAFT_REPO}/.git/config`))) return;

  // Don't clobber an existing repo for this lesson (e.g. re-publishing after a
  // fork already cloned one under this id).
  if (await exists(fs, `${ROOT}/${lessonId}/.git/config`)) return;

  await copyDir(fs, `${ROOT}/${DRAFT_REPO}`, `${ROOT}/${lessonId}`);
  await removeDir(fs, `${ROOT}/${DRAFT_REPO}`);
}

/** Delete a lesson's repository (used when the draft is reset or a lesson deleted). */
export async function deleteRepo(repoId) {
  await removeDir(gitFs(), `${ROOT}/${repoId}`);
}

/**
 * Copy one lesson's repository over another id, replacing whatever was there.
 *
 * This is how forking a lesson you already have locally works — "fork into a new
 * lesson" in the editor. Copying the object store is a real clone: git objects
 * are immutable and content-addressed, so the copy holds the same commits under
 * the same oids, and the fork therefore shares ancestry with what it came from.
 */
export async function copyRepo(fromRepoId, toRepoId) {
  const fs = gitFs();
  if (!(await exists(fs, `${ROOT}/${fromRepoId}/.git/config`))) return false;
  await removeDir(fs, `${ROOT}/${toRepoId}`);
  await copyDir(fs, `${ROOT}/${fromRepoId}`, `${ROOT}/${toRepoId}`);
  return true;
}

async function mkdirp(fs, path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      await fs.promises.mkdir(current);
    } catch {
      // Already exists — the normal case for the /lessons root.
    }
  }
}

async function copyDir(fs, from, to) {
  await mkdirp(fs, to);
  for (const name of await fs.promises.readdir(from)) {
    const src = `${from}/${name}`;
    const dst = `${to}/${name}`;
    const stat = await fs.promises.stat(src);
    if (stat.isDirectory()) {
      await copyDir(fs, src, dst);
    } else {
      await fs.promises.writeFile(dst, await fs.promises.readFile(src));
    }
  }
}

async function removeDir(fs, path) {
  if (!(await exists(fs, path))) return;
  for (const name of await fs.promises.readdir(path)) {
    const child = `${path}/${name}`;
    const stat = await fs.promises.stat(child);
    if (stat.isDirectory()) await removeDir(fs, child);
    else await fs.promises.unlink(child);
  }
  await fs.promises.rmdir(path);
}
