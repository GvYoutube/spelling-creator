// Document helpers shared by the version-control layer.
//
// These are deliberately kept free of any git dependency: the diff (ops.js) and
// the merge (merge.js) are pure functions over documents, and the editor's
// history UI imports them. Only the modules that actually touch the object store
// (layout.js, repo.js, pack.js, sync.js) pull in isomorphic-git, which lets the
// whole git engine be loaded on demand rather than shipped to every visitor —
// see load.js.

/**
 * Canonical JSON: object keys sorted, recursively. Arrays keep their order —
 * order is meaningful for sections, blocks, words and answers.
 *
 * This matters more than it looks. Blocks are built by spreading (`{ ...base,
 * answer }` in lib/questions.js, `{ ...block, id, type }` in lib/jsonImport.js),
 * so the same logical block can end up with different key *insertion* orders.
 * Serialising with plain JSON.stringify would then hash to a different blob oid
 * for identical content, and every such block would look "changed" on each
 * commit. Sorting the keys makes the oid depend only on content.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort())
      out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/**
 * The structure-only manifest for a doc: sections in order, each listing its
 * block ids in order. Block *content* is excluded — it lives in blocks/.
 */
export function docManifest(doc) {
  return {
    title: typeof doc?.title === "string" ? doc.title : "",
    ageRange: doc?.ageRange ?? null,
    sections: (doc?.sections || []).map((section) => ({
      id: section.id,
      name: typeof section.name === "string" ? section.name : "",
      blocks: (section.blocks || []).map((block) => block.id),
    })),
  };
}

/** Every block in a doc, flattened to a Map of blockId -> block. */
export function docBlocks(doc) {
  const blocks = new Map();
  for (const section of doc?.sections || []) {
    for (const block of section.blocks || []) blocks.set(block.id, block);
  }
  return blocks;
}

/**
 * Top-level doc fields that never leave this browser.
 *
 * `trustedCollaborators` holds collaborator *email addresses* (see lib/collab.js).
 * The lesson document travels in three ways, and the field must not go with it in
 * any of them:
 *
 *   - **the git repo** — packed and uploaded so other people can fork (clone) it,
 *     so anything committed is readable by anyone who forks the lesson;
 *   - **the live-collaboration Y.Doc** — mirrored to everyone the host admits to
 *     the session, who are not necessarily on the list;
 *   - **the lesson API** — `GET /lessons/:id` is public, so the Worker strips the
 *     field on the way out for everyone but the people it's for (see
 *     `stripCollaborators` in apps/api/src/lib/lesson.js).
 *
 * The first two are handled here: strip it before the doc goes anywhere
 * (stripLocalFields), and put it back from the live document when one comes back
 * (preserveLocalFields).
 */
const LOCAL_ONLY_FIELDS = ["trustedCollaborators"];

/**
 * Carry the local-only fields from the doc the user is editing onto a doc that
 * came from somewhere else. Restoring an old version, merging a fork, or
 * adopting a document from a live session must not wipe the lesson's
 * trusted-collaborator list, which none of those ever saw.
 */
export function preserveLocalFields(restored, current) {
  const doc = { ...restored };
  for (const field of LOCAL_ONLY_FIELDS) {
    if (current && current[field] !== undefined) doc[field] = current[field];
  }
  return doc;
}

/**
 * The document without its local-only fields — what may actually be sent.
 *
 * The git layout drops them implicitly (the tree is built from the manifest and
 * the blocks, and neither includes them). Anything that copies the document
 * wholesale, like the collaboration Y.Doc, has to drop them explicitly.
 */
export function stripLocalFields(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const out = { ...doc };
  for (const field of LOCAL_ONLY_FIELDS) delete out[field];
  return out;
}

/**
 * The repo id of the one working lesson the editor used to have, and the id the
 * library's migration gives it (see browser/storage.js) so its history survives.
 */
export const DRAFT_REPO = "draft";

/**
 * The repo id for a lesson: its hub id once it has one, and otherwise the id it
 * has in this device's library — which is what gives every local lesson a
 * repository of its own rather than all of them sharing one draft slot.
 *
 * `localId` is optional because the readers of a *published* lesson's repository
 * (the history tab, a proposal's diff) know its hub id and nothing else.
 */
export function repoIdFor(lessonId, localId) {
  return lessonId || localId || DRAFT_REPO;
}
