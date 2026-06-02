// Apply a small list of edit operations to a lesson document, instead of
// resending the whole thing. The Worker only offers a full-replace PUT, so the
// patch_lesson tool fetches the current doc, runs it through applyPatch here,
// and PUTs the result — but the assistant only has to send the diff.
//
// Operations address sections and blocks by their stable `id` (the ones
// get_lesson returns), not by array position — far more robust for a model than
// index- or JSON-pointer-based diffs, which drift as soon as anything shifts.
//
// New blocks reuse the canonical builder from doc.js, so a patched block is
// validated exactly like one created from scratch.

import { buildBlock, newId } from "./doc.js";

const OPS = [
  "set_title",
  "set_section_name",
  "add_section",
  "remove_section",
  "move_section",
  "add_block",
  "replace_block",
  "remove_block",
  "move_block",
];

function findSectionIndex(doc, sectionId, where) {
  const idx = doc.sections.findIndex((s) => s.id === sectionId);
  if (idx === -1) {
    throw new Error(
      `${where}: no section with id "${sectionId}". Call get_lesson to see the current ids.`,
    );
  }
  return idx;
}

function findBlock(doc, blockId, where) {
  for (let s = 0; s < doc.sections.length; s++) {
    const b = doc.sections[s].blocks.findIndex((blk) => blk.id === blockId);
    if (b !== -1) return { sectionIndex: s, blockIndex: b };
  }
  throw new Error(
    `${where}: no block with id "${blockId}". Call get_lesson to see the current ids.`,
  );
}

// Clamp an insertion index into [0, length]; a missing index means "append".
function insertAt(index, length) {
  if (index == null) return length;
  if (index < 0) return 0;
  return Math.min(index, length);
}

/**
 * Apply `operations` to a copy of `originalDoc` and return the new doc.
 * Throws a descriptive Error (naming the operation) on any invalid op, leaving
 * the caller's lesson untouched since we only ever mutate the clone.
 * @param {{ title?: string, sections?: any[] }} originalDoc
 * @param {any[]} operations
 * @returns {{ title: string, sections: any[] }}
 */
export function applyPatch(originalDoc, operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("Provide a non-empty list of operations.");
  }

  const doc = structuredClone(originalDoc || {});
  doc.title = typeof doc.title === "string" ? doc.title : "Untitled Lesson";
  if (!Array.isArray(doc.sections)) doc.sections = [];

  operations.forEach((op, i) => {
    const where = `operation ${i + 1} (${op?.op || "?"})`;
    if (!op || typeof op !== "object") {
      throw new Error(`${where}: each operation must be an object.`);
    }

    switch (op.op) {
      case "set_title": {
        if (typeof op.title !== "string" || !op.title.trim()) {
          throw new Error(`${where}: needs a non-empty "title".`);
        }
        doc.title = op.title;
        break;
      }

      case "set_section_name": {
        const idx = findSectionIndex(doc, op.sectionId, where);
        if (typeof op.name !== "string" || !op.name.trim()) {
          throw new Error(`${where}: needs a non-empty "name".`);
        }
        doc.sections[idx].name = op.name;
        break;
      }

      case "add_section": {
        const blocks = (Array.isArray(op.blocks) ? op.blocks : []).map((b, j) =>
          buildBlock(b, `${where}, block ${j + 1}`),
        );
        const section = {
          id: newId(),
          name: (op.name || `Section ${doc.sections.length + 1}`).toString(),
          blocks,
        };
        doc.sections.splice(
          insertAt(op.index, doc.sections.length),
          0,
          section,
        );
        break;
      }

      case "remove_section": {
        const idx = findSectionIndex(doc, op.sectionId, where);
        doc.sections.splice(idx, 1);
        break;
      }

      case "move_section": {
        const idx = findSectionIndex(doc, op.sectionId, where);
        if (typeof op.index !== "number") {
          throw new Error(`${where}: needs a numeric "index".`);
        }
        const [section] = doc.sections.splice(idx, 1);
        doc.sections.splice(
          insertAt(op.index, doc.sections.length),
          0,
          section,
        );
        break;
      }

      case "add_block": {
        const idx = findSectionIndex(doc, op.sectionId, where);
        if (!op.block) throw new Error(`${where}: needs a "block".`);
        const block = buildBlock(op.block, where);
        const blocks = doc.sections[idx].blocks;
        blocks.splice(insertAt(op.index, blocks.length), 0, block);
        break;
      }

      case "replace_block": {
        const { sectionIndex, blockIndex } = findBlock(doc, op.blockId, where);
        if (!op.block) throw new Error(`${where}: needs a "block".`);
        const block = buildBlock(op.block, where);
        block.id = op.blockId; // keep identity stable for later patches
        doc.sections[sectionIndex].blocks[blockIndex] = block;
        break;
      }

      case "remove_block": {
        const { sectionIndex, blockIndex } = findBlock(doc, op.blockId, where);
        doc.sections[sectionIndex].blocks.splice(blockIndex, 1);
        break;
      }

      case "move_block": {
        const { sectionIndex, blockIndex } = findBlock(doc, op.blockId, where);
        const [block] = doc.sections[sectionIndex].blocks.splice(blockIndex, 1);
        // `index` is the target position *after* removal. Target section
        // defaults to the block's current one.
        const targetIdx =
          op.sectionId != null
            ? findSectionIndex(doc, op.sectionId, where)
            : sectionIndex;
        const blocks = doc.sections[targetIdx].blocks;
        blocks.splice(insertAt(op.index, blocks.length), 0, block);
        break;
      }

      default:
        throw new Error(
          `${where}: unknown op "${op.op}". Valid ops: ${OPS.join(", ")}.`,
        );
    }
  });

  if (doc.sections.length === 0) {
    throw new Error(
      "The patch would leave the lesson with no sections; a lesson needs at least one.",
    );
  }
  return doc;
}

export const PATCH_OPS = OPS;
