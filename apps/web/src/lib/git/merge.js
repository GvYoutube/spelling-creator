// Merging = comparing block ids.
//
// Two people fork a lesson from a common ancestor and both edit it. To merge, we
// don't diff text — we line up the three docs (base, ours, theirs) by block id
// and decide each block independently:
//
//   changed on one side only   -> take that side          (no question to ask)
//   changed on both, same way  -> take it                 (they agree)
//   changed on both, different fields of the block
//                              -> merge the fields        (auto — one edited the
//                                                          caption, the other the
//                                                          width; both survive)
//   changed on both, same field, different values
//                              -> CONFLICT, ask the user
//   deleted one side, edited the other
//                              -> CONFLICT, ask the user  (deleting someone's
//                                                          edit is never safe to
//                                                          assume)
//
// Structure (which section a block sits in, and in what order) is merged
// separately and never raises a dialog: order is cheap for a human to fix and
// expensive for one to adjudicate, so a reorder on both sides resolves to ours
// and is reported in the summary instead.
//
// This module is pure — no git, no fs, no React. It takes three docs and returns
// a merged doc plus the conflicts. The caller (useLessonGit) fetches base/ours/
// theirs out of git and commits the result with two parents.

import { docBlocks } from "./doc.js";
import { sameValue } from "./ops.js";

/** Fields that identify a block rather than describe it — never merged. */
const IDENTITY_FIELDS = new Set(["id", "type"]);

/**
 * Merge one block three ways, field by field.
 * @returns {{ block: object, conflicts: Array<{field, ours, theirs, base}> }}
 *          `block` holds every auto-resolvable field already merged; contested
 *          fields are left at *our* value so the block is always renderable.
 */
export function mergeBlockFields(base, ours, theirs) {
  const fields = new Set([
    ...Object.keys(ours || {}),
    ...Object.keys(theirs || {}),
  ]);

  const block = {};
  const conflicts = [];

  for (const field of fields) {
    const o = ours?.[field];
    const t = theirs?.[field];
    const b = base?.[field];

    if (IDENTITY_FIELDS.has(field)) {
      block[field] = o !== undefined ? o : t;
      continue;
    }

    if (sameValue(o, t)) {
      block[field] = o; // both sides agree (including "neither touched it")
    } else if (sameValue(o, b)) {
      block[field] = t; // only they changed it
    } else if (sameValue(t, b)) {
      block[field] = o; // only we changed it
    } else {
      // Both changed it, to different things. Keep ours so the block stays
      // renderable, and surface the choice.
      block[field] = o;
      conflicts.push({ field, ours: o, theirs: t, base: b });
    }
  }

  return { block, conflicts };
}

/**
 * Three-way merge a list of ids (a section's block ids, or the doc's section
 * ids). Ours is the spine; ids the other side added are spliced in after the id
 * that precedes them there, and ids either side deleted drop out.
 *
 * Deliberately not a conflict source — see the note at the top of the file.
 */
function mergeIdList(base, ours, theirs, keep) {
  const baseSet = new Set(base);
  const ourSet = new Set(ours);
  const theirSet = new Set(theirs);

  // Start from our order, dropping anything they deleted that we didn't touch.
  const merged = ours.filter((id) => {
    const deletedByThem = baseSet.has(id) && !theirSet.has(id);
    return keep.has(id) && !deletedByThem;
  });

  // Splice in what they added, anchored to the id it follows on their side so a
  // block they appended to the middle doesn't jump to the end.
  for (let i = 0; i < theirs.length; i++) {
    const id = theirs[i];
    if (ourSet.has(id) || baseSet.has(id) || !keep.has(id)) continue;
    if (merged.includes(id)) continue;

    let at = merged.length;
    for (let j = i - 1; j >= 0; j--) {
      const anchor = merged.indexOf(theirs[j]);
      if (anchor !== -1) {
        at = anchor + 1;
        break;
      }
    }
    merged.splice(at, 0, id);
  }

  // Anything the resolution kept that neither list places (e.g. a "keep both"
  // clone whose anchor vanished) lands at the end rather than being lost.
  for (const id of keep) if (!merged.includes(id)) merged.push(id);

  return merged;
}

function sectionsById(doc) {
  const map = new Map();
  for (const section of doc?.sections || []) map.set(section.id, section);
  return map;
}

function blockIdsOf(doc, sectionId) {
  const section = sectionsById(doc).get(sectionId);
  return (section?.blocks || []).map((block) => block.id);
}

/**
 * Merge two documents that share a common ancestor.
 *
 * @param {object|null} base    The doc at the merge base (null = unrelated histories).
 * @param {object} ours         Our doc.
 * @param {object} theirs       Theirs.
 * @returns {{
 *   doc: object,                the merged doc, with contested blocks left at OUR value
 *   conflicts: Array<object>,   one per contested block — resolve with applyResolutions()
 *   auto: { merged: string[], tookTheirs: string[], added: string[], removed: string[] }
 * }}
 */
export function mergeDocs(base, ours, theirs) {
  const baseBlocks = docBlocks(base);
  const ourBlocks = docBlocks(ours);
  const theirBlocks = docBlocks(theirs);

  const ids = new Set([
    ...ourBlocks.keys(),
    ...theirBlocks.keys(),
    ...baseBlocks.keys(),
  ]);

  /** blockId -> the resolved block, or null when the merge deletes it. */
  const resolved = new Map();
  const conflicts = [];
  const auto = { merged: [], tookTheirs: [], added: [], removed: [] };

  for (const id of ids) {
    const b = baseBlocks.get(id);
    const o = ourBlocks.get(id);
    const t = theirBlocks.get(id);

    // Present on neither side any more: both deleted it. Agreed — it's gone.
    if (!o && !t) {
      resolved.set(id, null);
      auto.removed.push(id);
      continue;
    }

    // Only we have it.
    if (o && !t) {
      if (!b) {
        resolved.set(id, o); // we added it
        continue;
      }
      if (sameValue(o, b)) {
        resolved.set(id, null); // they deleted it, we didn't touch it
        auto.removed.push(id);
      } else {
        // They deleted a block we edited. Never guess.
        resolved.set(id, o);
        conflicts.push({
          blockId: id,
          kind: "delete/edit",
          deletedBy: "theirs",
          ours: o,
          theirs: null,
          base: b,
          fields: [],
          merged: o,
        });
      }
      continue;
    }

    // Only they have it.
    if (!o && t) {
      if (!b) {
        resolved.set(id, t); // they added it
        auto.added.push(id);
        continue;
      }
      if (sameValue(t, b)) {
        resolved.set(id, null); // we deleted it, they didn't touch it
        auto.removed.push(id);
      } else {
        resolved.set(id, t);
        conflicts.push({
          blockId: id,
          kind: "delete/edit",
          deletedBy: "ours",
          ours: null,
          theirs: t,
          base: b,
          fields: [],
          merged: t,
        });
      }
      continue;
    }

    // Both have it.
    if (sameValue(o, t)) {
      resolved.set(id, o); // identical — nothing to decide
      continue;
    }
    if (b && sameValue(o, b)) {
      resolved.set(id, t); // only they changed it
      auto.tookTheirs.push(id);
      continue;
    }
    if (b && sameValue(t, b)) {
      resolved.set(id, o); // only we changed it
      continue;
    }

    // Both changed it. Try to merge field by field.
    const { block, conflicts: fieldConflicts } = mergeBlockFields(b, o, t);
    if (fieldConflicts.length === 0) {
      resolved.set(id, block); // disjoint fields — both edits survive
      auto.merged.push(id);
      continue;
    }

    resolved.set(id, block);
    conflicts.push({
      blockId: id,
      kind: "edit/edit",
      ours: o,
      theirs: t,
      base: b,
      fields: fieldConflicts,
      // Every auto-resolvable field already merged, contested ones left at ours.
      merged: block,
    });
  }

  return {
    doc: assemble(base, ours, theirs, resolved),
    conflicts,
    auto,
  };
}

/**
 * Rebuild a doc from the resolved blocks, merging structure (section list,
 * section names, block order) around them.
 */
function assemble(base, ours, theirs, resolved) {
  const kept = new Set();
  for (const [id, block] of resolved) if (block) kept.add(id);

  const baseSections = sectionsById(base);
  const ourSections = sectionsById(ours);
  const theirSections = sectionsById(theirs);

  const sectionIds = mergeIdList(
    (base?.sections || []).map((s) => s.id),
    (ours?.sections || []).map((s) => s.id),
    (theirs?.sections || []).map((s) => s.id),
    // A section survives if either side still has it. Dropping a section would
    // orphan the blocks the block-level merge decided to keep.
    new Set([...ourSections.keys(), ...theirSections.keys()]),
  );

  // Blocks are placed in the first merged section that claims them, so a block
  // moved between sections on one side can't end up duplicated.
  const placed = new Set();
  const sections = [];

  for (const sectionId of sectionIds) {
    const our = ourSections.get(sectionId);
    const their = theirSections.get(sectionId);
    const original = baseSections.get(sectionId);

    const blockIds = mergeIdList(
      blockIdsOf(base, sectionId),
      blockIdsOf(ours, sectionId),
      blockIdsOf(theirs, sectionId),
      kept,
    ).filter((id) => !placed.has(id));

    for (const id of blockIds) placed.add(id);

    sections.push({
      id: sectionId,
      name: mergeName(original?.name, our?.name, their?.name),
      blocks: blockIds.map((id) => resolved.get(id)),
    });
  }

  // A kept block whose every section disappeared would otherwise be dropped.
  const orphans = [...kept].filter((id) => !placed.has(id));
  if (orphans.length > 0) {
    sections.push({
      id: `recovered-${orphans[0]}`,
      name: "Recovered blocks",
      blocks: orphans.map((id) => resolved.get(id)),
    });
  }

  const doc = {
    title: mergeName(base?.title, ours?.title, theirs?.title) || "",
    sections,
  };
  const ageRange = mergeName(base?.ageRange, ours?.ageRange, theirs?.ageRange);
  if (ageRange) doc.ageRange = ageRange;
  return doc;
}

/** Three-way merge of a scalar, preferring ours when both sides changed it. */
function mergeName(base, ours, theirs) {
  if (sameValue(ours, theirs)) return ours;
  if (sameValue(ours, base)) return theirs;
  return ours;
}

/**
 * Apply the user's choices from the conflict dialog to a merge result.
 *
 * @param {object} merged   The `doc` from mergeDocs (contested blocks at our value).
 * @param {object[]} conflicts  The conflicts from the same call.
 * @param {Record<string, "ours"|"theirs"|"both">} choices  Keyed by blockId.
 * @param {Function} newId  Id factory, for the clone a "both" choice creates.
 */
export function applyResolutions(merged, conflicts, choices, newId) {
  let doc = { ...merged, sections: merged.sections.map((s) => ({ ...s })) };

  for (const conflict of conflicts) {
    const choice = choices[conflict.blockId] || "ours";
    const { blockId, kind } = conflict;

    if (kind === "delete/edit") {
      // "ours"/"theirs" here mean "keep the surviving edit" or "honour the
      // delete" — whichever side still has the block is the one that edited it.
      const survivor = conflict.ours || conflict.theirs;
      const keep = choice === "both" || choice === keptSide(conflict);
      doc = replaceBlock(doc, blockId, keep ? survivor : null, null, newId);
      continue;
    }

    // edit/edit. `merged` already holds every auto-resolved field; a choice only
    // settles the contested ones.
    const base = conflict.merged;
    if (choice === "ours") {
      doc = replaceBlock(
        doc,
        blockId,
        withFields(base, conflict, "ours"),
        null,
        newId,
      );
    } else if (choice === "theirs") {
      doc = replaceBlock(
        doc,
        blockId,
        withFields(base, conflict, "theirs"),
        null,
        newId,
      );
    } else {
      // Keep both: ours stays put, theirs is cloned in beside it under a fresh
      // id (a new id, because the old one now belongs to our copy).
      doc = replaceBlock(
        doc,
        blockId,
        withFields(base, conflict, "ours"),
        withFields(base, conflict, "theirs"),
        newId,
      );
    }
  }

  return doc;
}

/** Which side of a delete/edit conflict still holds the block. */
function keptSide(conflict) {
  return conflict.deletedBy === "theirs" ? "ours" : "theirs";
}

/** The merged block with its contested fields set from one side. */
function withFields(merged, conflict, side) {
  const block = { ...merged };
  for (const field of conflict.fields) block[field.field] = field[side];
  return block;
}

/**
 * Put `block` in place of `blockId` (or remove it when null), optionally
 * inserting `clone` right after it under a fresh id.
 */
function replaceBlock(doc, blockId, block, clone, newId) {
  return {
    ...doc,
    sections: doc.sections.map((section) => {
      if (!section.blocks.some((b) => b && b.id === blockId)) return section;
      const blocks = [];
      for (const existing of section.blocks) {
        if (!existing || existing.id !== blockId) {
          blocks.push(existing);
          continue;
        }
        if (block) blocks.push(block);
        if (clone) blocks.push({ ...clone, id: newId() });
      }
      return { ...section, blocks };
    }),
  };
}
