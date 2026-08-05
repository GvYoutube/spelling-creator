// Edits as operations.
//
// The editor never tells us what the user did — it just hands us a new document
// (setDoc replaces state wholesale; see EditorPage). So we *recover* the intent
// by diffing the previous doc against the next one, keyed by block id, and
// expressing the difference as a list of operations:
//
//   title.set / ageRange.set
//   section.add | section.remove | section.rename | section.move
//   block.add   | block.remove   | block.edit     | block.move
//
// Because blocks carry stable ids (lib/id.js) this diff is exact where a textual
// diff would only guess: a block dragged between sections is a `block.move`, not
// a delete plus an unrelated add, and a block whose text changed is a `block.edit`
// even if it also moved. Ops are what the commit message is written from, and
// what the history UI shows for each commit.
//
// The same op list is derivable two ways, and both are used:
//   - diffDocs(prev, next)          in-memory, for the pending-changes indicator
//   - diffTrees(...) in repo.js     from two commits' block-id -> blob-oid maps
// They agree by construction, because a block's blob oid is a hash of its
// canonical JSON (see layout.js).

// From doc.js, not layout.js: these are pure, so the diff (and the history UI
// that renders it) never pulls the git engine into the main bundle.
import { canonicalJson, docBlocks } from "./doc.js";

/** Deep value equality via canonical JSON — key order can't cause a false diff. */
export function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * The fields of two versions of a block that actually differ. `id` and `type`
 * are excluded: `id` is the block's identity (equal by construction here) and a
 * block's `type` never changes in the editor — a retyped block is a new block.
 */
export function changedFields(before, after) {
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  keys.delete("id");
  keys.delete("type");
  const changed = [];
  for (const key of keys) {
    if (!sameValue(before?.[key], after?.[key])) changed.push(key);
  }
  return changed.sort();
}

// Where each block lives in a doc: blockId -> { sectionId, index }.
function blockPositions(doc) {
  const positions = new Map();
  for (const section of doc?.sections || []) {
    (section.blocks || []).forEach((block, index) => {
      positions.set(block.id, { sectionId: section.id, index });
    });
  }
  return positions;
}

function sectionIndex(doc) {
  const sections = new Map();
  (doc?.sections || []).forEach((section, index) => {
    sections.set(section.id, { section, index });
  });
  return sections;
}

/**
 * Diff two documents into an ordered list of operations.
 *
 * @param {object} prev  The document before the edit.
 * @param {object} next  The document after it.
 * @returns {Array<object>} ops — [] when the documents are equivalent.
 */
export function diffDocs(prev, next) {
  const ops = [];

  if (!sameValue(prev?.title, next?.title)) {
    ops.push({
      op: "title.set",
      from: prev?.title ?? "",
      to: next?.title ?? "",
    });
  }
  if (!sameValue(prev?.ageRange, next?.ageRange)) {
    ops.push({
      op: "ageRange.set",
      from: prev?.ageRange ?? null,
      to: next?.ageRange ?? null,
    });
  }

  // ---- sections ----
  const prevSections = sectionIndex(prev);
  const nextSections = sectionIndex(next);

  for (const [id, { section, index }] of nextSections) {
    const before = prevSections.get(id);
    if (!before) {
      ops.push({
        op: "section.add",
        sectionId: id,
        name: section.name || "",
        index,
      });
      continue;
    }
    if (before.section.name !== section.name) {
      ops.push({
        op: "section.rename",
        sectionId: id,
        from: before.section.name || "",
        to: section.name || "",
      });
    }
    if (before.index !== index) {
      ops.push({
        op: "section.move",
        sectionId: id,
        name: section.name || "",
        from: before.index,
        to: index,
      });
    }
  }
  for (const [id, { section }] of prevSections) {
    if (!nextSections.has(id)) {
      ops.push({
        op: "section.remove",
        sectionId: id,
        name: section.name || "",
      });
    }
  }

  // ---- blocks (by id — the heart of it) ----
  const prevBlocks = docBlocks(prev);
  const nextBlocks = docBlocks(next);
  const prevAt = blockPositions(prev);
  const nextAt = blockPositions(next);

  for (const [id, block] of nextBlocks) {
    const before = prevBlocks.get(id);
    const at = nextAt.get(id);

    if (!before) {
      ops.push({
        op: "block.add",
        blockId: id,
        blockType: block.type,
        sectionId: at?.sectionId,
        index: at?.index,
      });
      continue;
    }

    // An edit and a move are independent facts about the same block, so a block
    // that was both retyped and dragged emits both ops.
    const fields = changedFields(before, block);
    if (fields.length > 0) {
      ops.push({
        op: "block.edit",
        blockId: id,
        blockType: block.type,
        sectionId: at?.sectionId,
        fields,
      });
    }

    const from = prevAt.get(id);
    if (
      from &&
      at &&
      (from.sectionId !== at.sectionId || from.index !== at.index)
    ) {
      ops.push({
        op: "block.move",
        blockId: id,
        blockType: block.type,
        fromSectionId: from.sectionId,
        toSectionId: at.sectionId,
        fromIndex: from.index,
        toIndex: at.index,
      });
    }
  }

  for (const [id, block] of prevBlocks) {
    if (!nextBlocks.has(id)) {
      ops.push({
        op: "block.remove",
        blockId: id,
        blockType: block.type,
        sectionId: prevAt.get(id)?.sectionId,
      });
    }
  }

  return ops;
}

// Human-readable names for block types, singular and plural.
const TYPE_LABEL = {
  text: ["text block", "text blocks"],
  image: ["image", "images"],
  spelling: ["spelling list", "spelling lists"],
  question: ["question", "questions"],
};

function label(type, count) {
  const pair = TYPE_LABEL[type] || ["block", "blocks"];
  return count === 1 ? pair[0] : pair[1];
}

function phrase(verb, type, count) {
  return `${verb} ${count} ${label(type, count)}`;
}

// Group ops of one kind by block type and render them as "added 2 questions".
function summarizeKind(ops, kind, verb) {
  const counts = new Map();
  for (const op of ops) {
    if (op.op !== kind) continue;
    counts.set(op.blockType, (counts.get(op.blockType) || 0) + 1);
  }
  return [...counts].map(([type, count]) => phrase(verb, type, count));
}

/**
 * A commit message for a batch of operations: a one-line summary, then a body
 * listing each op. The summary is what the history timeline shows.
 *
 * "Untitled change" is never produced — describeOps is only called with a
 * non-empty op list (an empty one means nothing to commit; see repo.js).
 */
export function describeOps(ops) {
  // Verbs stay lowercase here and the whole summary is sentence-cased at the
  // end, so a multi-part summary reads "Add 1 image, remove 2 questions".
  const parts = [
    ...summarizeKind(ops, "block.add", "add"),
    ...summarizeKind(ops, "block.edit", "edit"),
    ...summarizeKind(ops, "block.remove", "remove"),
  ];

  const moves = ops.filter((op) => op.op === "block.move").length;
  if (moves) parts.push(`move ${moves} ${moves === 1 ? "block" : "blocks"}`);

  const sectionAdds = ops.filter((op) => op.op === "section.add").length;
  if (sectionAdds) {
    parts.push(
      `add ${sectionAdds} ${sectionAdds === 1 ? "section" : "sections"}`,
    );
  }
  const sectionRemoves = ops.filter((op) => op.op === "section.remove").length;
  if (sectionRemoves) {
    parts.push(
      `remove ${sectionRemoves} ${sectionRemoves === 1 ? "section" : "sections"}`,
    );
  }
  const sectionRenames = ops.filter((op) => op.op === "section.rename").length;
  if (sectionRenames) parts.push("rename sections");
  const sectionMoves = ops.filter((op) => op.op === "section.move").length;
  if (sectionMoves) parts.push("reorder sections");

  const titleSet = ops.find((op) => op.op === "title.set");
  if (titleSet) parts.push("retitle the lesson");
  if (ops.some((op) => op.op === "ageRange.set"))
    parts.push("set the age range");

  // Only structural/meta ops (e.g. a lone retitle) — say so plainly.
  if (parts.length === 0) parts.push("update the lesson");

  let summary = parts.join(", ");
  summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  if (summary.length > 72) summary = `${summary.slice(0, 69)}...`;

  const body = ops.map(describeOp).join("\n");
  return `${summary}\n\n${body}\n`;
}

/** One op as a single line, for the commit body and the history detail view. */
export function describeOp(op) {
  switch (op.op) {
    case "title.set":
      return `- retitle: "${op.from}" -> "${op.to}"`;
    case "ageRange.set":
      return `- age range: ${op.from || "none"} -> ${op.to || "none"}`;
    case "section.add":
      return `- add section "${op.name}"`;
    case "section.remove":
      return `- remove section "${op.name}"`;
    case "section.rename":
      return `- rename section "${op.from}" -> "${op.to}"`;
    case "section.move":
      return `- move section "${op.name}" (${op.from} -> ${op.to})`;
    case "block.add":
      return `- add ${label(op.blockType, 1)} ${op.blockId}`;
    case "block.remove":
      return `- remove ${label(op.blockType, 1)} ${op.blockId}`;
    case "block.edit":
      return `- edit ${label(op.blockType, 1)} ${op.blockId} (${op.fields.join(", ")})`;
    case "block.move":
      return `- move ${label(op.blockType, 1)} ${op.blockId}`;
    default:
      return `- ${op.op}`;
  }
}

/** The summary line of a commit message (what the timeline renders). */
export function summaryOf(message) {
  return (message || "").split("\n")[0].trim();
}
