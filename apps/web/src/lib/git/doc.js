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
 * Top-level doc fields that are deliberately NOT versioned.
 *
 * `trustedCollaborators` holds collaborator *email addresses* (see lib/collab.js).
 * A lesson's repo is packed and uploaded so other people can fork (clone) it, so
 * anything committed would be readable by anyone who forks the lesson. Emails
 * must not travel with it. They're carried across a restore/merge from the live
 * doc instead — see preserveLocalFields().
 */
const UNVERSIONED_FIELDS = ["trustedCollaborators"];

/**
 * Carry the unversioned fields from the doc the user is editing onto a doc that
 * came out of git. Restoring an old version or merging a fork must not wipe the
 * lesson's trusted-collaborator list, which git never saw.
 */
export function preserveLocalFields(restored, current) {
  const doc = { ...restored };
  for (const field of UNVERSIONED_FIELDS) {
    if (current && current[field] !== undefined) doc[field] = current[field];
  }
  return doc;
}

/** The repo id used before a lesson has been saved to the hub. */
export const DRAFT_REPO = "draft";

/** The repo id for a lesson: its hub id, or the draft repo when unattached. */
export function repoIdFor(editingId) {
  return editingId || DRAFT_REPO;
}
