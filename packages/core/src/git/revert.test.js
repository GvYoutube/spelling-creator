// Undoing one change without losing everything after it.
//
// Restoring is the blunt instrument and always worked; this is the precise one,
// and it is the same three-way merge with the sides pointed backwards:
//
//   base   the document as that commit left it
//   ours   the document now
//   theirs the document as it was immediately before
//
// The property worth protecting is the one in the name — everything changed since
// survives — and the property worth protecting *next* is that a change built on
// since raises a conflict rather than being quietly reversed under the author.
// prepareRevert is bound to the browser's filesystem; the call it makes is this.

import { describe, expect, it } from "vitest";
import { mergeDocs } from "./merge.js";
import { diffDocs } from "./ops.js";

function doc(one, two, three) {
  return {
    title: "Lesson",
    sections: [
      {
        id: "s1",
        name: "One",
        blocks: [
          { id: "b1", type: "text", text: one },
          { id: "b2", type: "text", text: two },
          { id: "b3", type: "text", text: three },
        ],
      },
    ],
  };
}

const textOf = (d, id) =>
  d.sections[0].blocks.find((b) => b.id === id)?.text ?? null;

/** The revert, expressed exactly as prepareRevert expresses it. */
const revert = ({ before, after, now }) => mergeDocs(after, now, before);

describe("undoing one change", () => {
  it("puts back what that change touched", () => {
    const before = doc("original", "b", "c");
    const after = doc("CHANGED", "b", "c");

    const result = revert({ before, after, now: after });
    expect(textOf(result.doc, "b1")).toBe("original");
    expect(result.conflicts).toHaveLength(0);
  });

  it("keeps everything changed since — which is the whole point", () => {
    const before = doc("original", "b", "c");
    const after = doc("CHANGED", "b", "c");
    // Two later edits, in blocks the reverted change never touched.
    const now = doc("CHANGED", "LATER", "ALSO LATER");

    const result = revert({ before, after, now });
    expect(textOf(result.doc, "b1")).toBe("original"); // undone
    expect(textOf(result.doc, "b2")).toBe("LATER"); // kept
    expect(textOf(result.doc, "b3")).toBe("ALSO LATER"); // kept
    expect(result.conflicts).toHaveLength(0);
  });

  it("asks when the change being undone has been built on", () => {
    const before = doc("original", "b", "c");
    const after = doc("CHANGED", "b", "c");
    // Somebody has since edited the very block the change altered. Reversing it
    // silently would throw their edit away.
    const now = doc("CHANGED AND THEN SOME", "b", "c");

    const result = revert({ before, after, now });
    expect(result.conflicts.map((c) => c.blockId)).toEqual(["b1"]);
  });

  it("puts back a block the change removed", () => {
    const before = doc("a", "b", "c");
    const after = {
      ...before,
      sections: [
        {
          ...before.sections[0],
          blocks: before.sections[0].blocks.filter((b) => b.id !== "b2"),
        },
      ],
    };

    const result = revert({ before, after, now: after });
    expect(textOf(result.doc, "b2")).toBe("b");
  });

  it("removes a block the change added", () => {
    const before = doc("a", "b", "c");
    const added = {
      ...before,
      sections: [
        {
          ...before.sections[0],
          blocks: [
            ...before.sections[0].blocks,
            { id: "b4", type: "text", text: "new" },
          ],
        },
      ],
    };

    const result = revert({ before, after: added, now: added });
    expect(textOf(result.doc, "b4")).toBe(null);
    expect(textOf(result.doc, "b1")).toBe("a");
  });

  it("is a no-op when the change is no longer in the lesson", () => {
    const before = doc("original", "b", "c");
    const after = doc("CHANGED", "b", "c");
    // It was already undone by hand; there is nothing left to reverse.
    const now = doc("original", "b", "c");

    const result = revert({ before, after, now });
    expect(diffDocs(now, result.doc)).toHaveLength(0);
  });
});
