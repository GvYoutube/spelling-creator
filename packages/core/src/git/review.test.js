// Reading a proposal without merging it.
//
// The proposal page now answers two questions off the git objects alone — what
// did the proposer change, and would it merge cleanly — and both answers hinge on
// using the **merge base** rather than the lesson's current tip. Getting that
// wrong doesn't crash; it quietly shows a reviewer the author's own edits as
// though the proposer had made them, which is worse.
//
// So these build the real situation: a lesson, a fork of it, and both sides
// moving on. prepareProposalReview itself is bound to the browser's filesystem,
// but the three calls it makes are these, over the same objects.

import { describe, expect, it } from "vitest";
import { memRepo } from "./memfs.js";
import {
  cloneFromPack,
  contains,
  fetchRemotePack,
  mergeBase,
  packRepo,
} from "./pack.js";
import { mergeDocs } from "./merge.js";
import { diffDocs } from "./ops.js";
import { commitDoc, headOid, readDocAt } from "./repo.js";

const author = { name: "Test", email: "test@example.com" };

/** A lesson of two text blocks, each addressable so a test can move one. */
function doc(one, two) {
  return {
    title: "Lesson",
    sections: [
      {
        id: "s1",
        name: "One",
        blocks: [
          { id: "b1", type: "text", text: one },
          { id: "b2", type: "text", text: two },
        ],
      },
    ],
  };
}

/**
 * A lesson and a fork of it, sharing ancestry the way a real fork does — through
 * a packfile, so the commits really are the same objects.
 */
async function lessonAndFork() {
  const lesson = memRepo("lesson");
  await commitDoc({ ...lesson, doc: doc("first", "second"), author });

  const fork = memRepo("fork");
  await cloneFromPack({ ...fork, ...(await packRepo(lesson)) });
  return { lesson, fork };
}

describe("what a proposal changes", () => {
  it("is measured from where the two histories diverged, not from the lesson now", async () => {
    const { lesson, fork } = await lessonAndFork();

    // Both move on, in different blocks.
    await commitDoc({ ...lesson, doc: doc("first", "AUTHOR"), author });
    await commitDoc({ ...fork, doc: doc("PROPOSER", "second"), author });

    // One store holding both histories — the reviewer's repository.
    const shared = memRepo("shared");
    await cloneFromPack({ ...shared, ...(await packRepo(lesson)) });
    const ours = await headOid(shared);
    const theirPack = await packRepo(fork);
    await fetchRemotePack({
      ...shared,
      ...theirPack,
      ref: "refs/remotes/pull/1",
    });
    const theirs = theirPack.head;

    const base = await mergeBase({ ...shared, ours, theirs });
    expect(base).toBeTruthy();

    const [baseDoc, theirDoc] = [
      await readDocAt({ ...shared, oid: base }),
      await readDocAt({ ...shared, oid: theirs }),
    ];

    // Against the base: exactly the one block the proposer touched.
    const ops = diffDocs(baseDoc, theirDoc);
    expect(
      ops.filter((o) => o.op === "block.edit").map((o) => o.blockId),
    ).toEqual(["b1"]);

    // Against the lesson's tip it would have read as two — the proposer's edit
    // *and* the author's, reversed. That is the mistake this guards.
    const ourDoc = await readDocAt({ ...shared, oid: ours });
    expect(
      diffDocs(ourDoc, theirDoc).filter((o) => o.op === "block.edit").length,
    ).toBe(2);
  });

  it("reports no conflicts when the two sides touched different blocks", async () => {
    const { lesson, fork } = await lessonAndFork();
    await commitDoc({ ...lesson, doc: doc("first", "AUTHOR"), author });
    await commitDoc({ ...fork, doc: doc("PROPOSER", "second"), author });

    const shared = memRepo("shared");
    await cloneFromPack({ ...shared, ...(await packRepo(lesson)) });
    const ours = await headOid(shared);
    const theirPack = await packRepo(fork);
    await fetchRemotePack({
      ...shared,
      ...theirPack,
      ref: "refs/remotes/pull/1",
    });

    const base = await mergeBase({ ...shared, ours, theirs: theirPack.head });
    const merged = mergeDocs(
      await readDocAt({ ...shared, oid: base }),
      await readDocAt({ ...shared, oid: ours }),
      await readDocAt({ ...shared, oid: theirPack.head }),
    );
    expect(merged.conflicts).toHaveLength(0);
  });

  it("counts a conflict when both changed the same field of one block", async () => {
    const { lesson, fork } = await lessonAndFork();
    await commitDoc({ ...lesson, doc: doc("AUTHOR", "second"), author });
    await commitDoc({ ...fork, doc: doc("PROPOSER", "second"), author });

    const shared = memRepo("shared");
    await cloneFromPack({ ...shared, ...(await packRepo(lesson)) });
    const ours = await headOid(shared);
    const theirPack = await packRepo(fork);
    await fetchRemotePack({
      ...shared,
      ...theirPack,
      ref: "refs/remotes/pull/1",
    });

    const base = await mergeBase({ ...shared, ours, theirs: theirPack.head });
    const merged = mergeDocs(
      await readDocAt({ ...shared, oid: base }),
      await readDocAt({ ...shared, oid: ours }),
      await readDocAt({ ...shared, oid: theirPack.head }),
    );
    expect(merged.conflicts.map((c) => c.blockId)).toEqual(["b1"]);
  });

  it("knows when a proposal is already part of the lesson", async () => {
    const { lesson, fork } = await lessonAndFork();
    await commitDoc({ ...fork, doc: doc("PROPOSER", "second"), author });

    const shared = memRepo("shared");
    await cloneFromPack({ ...shared, ...(await packRepo(lesson)) });
    const before = await headOid(shared);
    const theirPack = await packRepo(fork);
    await fetchRemotePack({
      ...shared,
      ...theirPack,
      ref: "refs/remotes/pull/1",
    });

    expect(
      await contains({ ...shared, oid: before, ancestor: theirPack.head }),
    ).toBe(false);

    // Landing it — a merge commit joining the two histories, which is what a
    // reviewer's confirm produces.
    await commitDoc({
      ...shared,
      doc: doc("PROPOSER", "second"),
      author,
      parents: [before, theirPack.head],
    });

    expect(
      await contains({
        ...shared,
        oid: await headOid(shared),
        ancestor: theirPack.head,
      }),
    ).toBe(true);
  });
});

describe("fast-forwarding", () => {
  it("is available exactly when the lesson hasn't moved since the fork", async () => {
    const { lesson, fork } = await lessonAndFork();
    await commitDoc({ ...fork, doc: doc("PROPOSER", "second"), author });

    const shared = memRepo("shared");
    await cloneFromPack({ ...shared, ...(await packRepo(lesson)) });
    const ours = await headOid(shared);
    const theirPack = await packRepo(fork);
    await fetchRemotePack({
      ...shared,
      ...theirPack,
      ref: "refs/remotes/pull/1",
    });

    // The lesson is the merge base: nothing of ours sits on top of it, so
    // "merging" is only moving our branch to theirs.
    expect(await mergeBase({ ...shared, ours, theirs: theirPack.head })).toBe(
      ours,
    );
  });

  it("is not available once the lesson has its own commits", async () => {
    const { lesson, fork } = await lessonAndFork();
    await commitDoc({ ...fork, doc: doc("PROPOSER", "second"), author });
    await commitDoc({ ...lesson, doc: doc("first", "AUTHOR"), author });

    const shared = memRepo("shared");
    await cloneFromPack({ ...shared, ...(await packRepo(lesson)) });
    const ours = await headOid(shared);
    const theirPack = await packRepo(fork);
    await fetchRemotePack({
      ...shared,
      ...theirPack,
      ref: "refs/remotes/pull/1",
    });

    expect(
      await mergeBase({ ...shared, ours, theirs: theirPack.head }),
    ).not.toBe(ours);
  });
});
