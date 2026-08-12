// Branches — the thing an author sees as "another version of this lesson I'm
// trying out".
//
// These drive the real engine over the in-memory filesystem, for the reason
// memfs.test.js does: the contract that matters is not "we wrote a ref" but
// "isomorphic-git agrees, a pack carries it, and a clone gets it back". The
// round trip below is exactly the one a second device makes.

import { describe, expect, it } from "vitest";
import { memRepo } from "./memfs.js";
import { cloneFromPack, packRepo } from "./pack.js";
import {
  branchLabel,
  isBranchName,
  parseRefMap,
  toBranchName,
} from "./refs.js";
import {
  BRANCH,
  checkoutBranch,
  commitDoc,
  createBranch,
  currentBranch,
  deleteBranch,
  deletedBranches,
  headOid,
  history,
  listBranches,
  renameBranch,
} from "./repo.js";

const author = { name: "Test", email: "test@example.com" };

function doc(title, text) {
  return {
    title,
    sections: [
      { id: "s1", name: "One", blocks: [{ id: "b1", type: "text", text }] },
    ],
  };
}

/** A repo with one commit on the default branch. */
async function seeded() {
  const ctx = memRepo();
  await commitDoc({ ...ctx, doc: doc("Lesson", "first"), author });
  return ctx;
}

describe("branch names", () => {
  it("turns what someone typed into something git will store", () => {
    expect(toBranchName("Simpler for Year 3")).toBe("Simpler-for-Year-3");
    expect(toBranchName("  spaced   out  ")).toBe("spaced-out");
    expect(toBranchName("emoji ✨ and ?marks")).toBe("emoji-and-marks");
  });

  it("reads a stored name back as the words it came from", () => {
    expect(branchLabel(toBranchName("Simpler for Year 3"))).toBe(
      "Simpler for Year 3",
    );
  });

  it("refuses the names git refuses, and anything with nothing left in it", () => {
    expect(toBranchName("???")).toBe("");
    expect(toBranchName("   ")).toBe("");
    expect(isBranchName("a..b")).toBe(false);
    expect(isBranchName("thing.lock")).toBe(false);
    expect(isBranchName("-leading")).toBe(false);
    expect(isBranchName("with space")).toBe(false);
    expect(isBranchName("x".repeat(33))).toBe(false);
    // git refuses a ref that ends in a dot, so we must too.
    expect(isBranchName("Year-3.")).toBe(false);
    expect(toBranchName("Year 3.")).toBe("Year-3");
  });

  it("keeps a long name inside the limit, cut on a separator", () => {
    const name = toBranchName("A really quite long name for a variation here");
    expect(name.length).toBeLessThanOrEqual(32);
    expect(isBranchName(name)).toBe(true);
    expect(name.endsWith("-")).toBe(false);
  });

  it("reads a ref map only when every part of it is one", () => {
    const oid = "a".repeat(40);
    expect(parseRefMap(`{"main":"${oid}"}`)).toEqual({ main: oid });
    // "" is a claim of absence, which an expected-map is allowed to make.
    expect(parseRefMap('{"main":""}')).toEqual({ main: "" });
    expect(parseRefMap('{"main":"nope"}')).toBe(null);
    expect(parseRefMap('{"bad name":"' + oid + '"}')).toBe(null);
    expect(parseRefMap("not json")).toBe(null);
    expect(parseRefMap('["main"]')).toBe(null);
  });
});

describe("committing on a branch", () => {
  it("follows HEAD rather than always writing the default branch", async () => {
    const ctx = await seeded();
    const start = await headOid(ctx);

    await createBranch({ ...ctx, name: "Year-3" });
    expect(await currentBranch(ctx)).toBe("Year-3");

    await commitDoc({ ...ctx, doc: doc("Lesson", "on the variation"), author });

    // The variation moved; the lesson did not.
    expect(await headOid({ ...ctx, ref: `refs/heads/${BRANCH}` })).toBe(start);
    expect(await headOid({ ...ctx, ref: "refs/heads/Year-3" })).not.toBe(start);
  });

  it("gives each branch its own history", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await commitDoc({ ...ctx, doc: doc("Lesson", "second"), author });

    expect(await history(ctx)).toHaveLength(2);
    expect(await history({ ...ctx, ref: `refs/heads/${BRANCH}` })).toHaveLength(
      1,
    );
  });

  it("hands back the document at the branch being switched to", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await commitDoc({ ...ctx, doc: doc("Lesson", "changed here"), author });

    const back = await checkoutBranch({ ...ctx, name: BRANCH });
    expect(back.doc.sections[0].blocks[0].text).toBe("first");
    expect(await currentBranch(ctx)).toBe(BRANCH);
  });

  it("counts how far a variation has run ahead of the lesson", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await commitDoc({ ...ctx, doc: doc("Lesson", "a"), author });
    await commitDoc({ ...ctx, doc: doc("Lesson", "b"), author });

    const branches = await listBranches(ctx);
    expect(branches.map((b) => b.name)).toEqual([BRANCH, "Year-3"]);
    expect(branches.find((b) => b.name === BRANCH).ahead).toBe(0);
    expect(branches.find((b) => b.name === "Year-3").ahead).toBe(2);
  });
});

describe("travelling", () => {
  it("packs every branch, and a clone gets them all back", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await commitDoc({ ...ctx, doc: doc("Lesson", "variation"), author });
    await checkoutBranch({ ...ctx, name: BRANCH });

    const packed = await packRepo(ctx);
    expect(new Set(Object.keys(packed.refs))).toEqual(
      new Set([BRANCH, "Year-3"]),
    );
    // `head` is the lesson, not whichever branch happens to be furthest along.
    expect(packed.head).toBe(
      await headOid({ ...ctx, ref: `refs/heads/${BRANCH}` }),
    );

    const clone = memRepo("clone");
    await cloneFromPack({ ...clone, ...packed });

    expect((await listBranches(clone)).map((b) => b.name)).toEqual([
      BRANCH,
      "Year-3",
    ]);
    // A clone arrives at the lesson, whatever the author was last editing.
    expect(await currentBranch(clone)).toBe(BRANCH);
    expect(await headOid({ ...clone, ref: "refs/heads/Year-3" })).toBe(
      packed.refs["Year-3"],
    );
  });

  it("packs only what was asked for, so a proposal carries the lesson alone", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await commitDoc({ ...ctx, doc: doc("Lesson", "variation"), author });

    const packed = await packRepo({ ...ctx, only: [BRANCH] });
    expect(Object.keys(packed.refs)).toEqual([BRANCH]);
  });

  it("treats a pack with no branch map as the one branch it has", async () => {
    const ctx = await seeded();
    const packed = await packRepo(ctx);

    const clone = memRepo("clone");
    await cloneFromPack({ ...clone, ...packed, refs: null });
    expect((await listBranches(clone)).map((b) => b.name)).toEqual([BRANCH]);
  });
});

describe("removing a variation", () => {
  it("leaves a marker, so the deletion can reach the hub", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await commitDoc({ ...ctx, doc: doc("Lesson", "variation"), author });
    const tip = await headOid(ctx);
    await checkoutBranch({ ...ctx, name: BRANCH });

    expect(await deleteBranch({ ...ctx, name: "Year-3" })).toBe(true);
    expect((await listBranches(ctx)).map((b) => b.name)).toEqual([BRANCH]);
    expect(await deletedBranches(ctx)).toEqual({ "Year-3": tip });
  });

  it("forgets the deletion when the same name is used again", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await commitDoc({ ...ctx, doc: doc("Lesson", "variation"), author });
    await checkoutBranch({ ...ctx, name: BRANCH });
    await deleteBranch({ ...ctx, name: "Year-3" });

    // Reusing the name is not the deleted variation coming back. Left behind, the
    // marker would make the next push ask to create and delete one name at once.
    await createBranch({ ...ctx, name: "Year-3" });
    expect(await deletedBranches(ctx)).toEqual({});
  });

  it("forgets it when a rename takes the name instead", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await checkoutBranch({ ...ctx, name: BRANCH });
    await createBranch({ ...ctx, name: "Year-5" });
    await checkoutBranch({ ...ctx, name: BRANCH });
    await deleteBranch({ ...ctx, name: "Year-3" });

    await renameBranch({ ...ctx, from: "Year-5", to: "Year-3" });
    // "Year-5" is gone and marked; "Year-3" exists again and must not be.
    expect(Object.keys(await deletedBranches(ctx))).toEqual(["Year-5"]);
  });

  it("refuses to remove the lesson, or the branch being edited", async () => {
    const ctx = await seeded();
    await expect(deleteBranch({ ...ctx, name: BRANCH })).rejects.toThrow();

    await createBranch({ ...ctx, name: "Year-3" });
    await expect(deleteBranch({ ...ctx, name: "Year-3" })).rejects.toThrow();
  });
});

describe("renaming", () => {
  it("carries HEAD across, and records the old name as gone", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await commitDoc({ ...ctx, doc: doc("Lesson", "variation"), author });
    const tip = await headOid(ctx);

    await renameBranch({ ...ctx, from: "Year-3", to: "Year-4" });

    expect(await currentBranch(ctx)).toBe("Year-4");
    expect(await headOid(ctx)).toBe(tip);
    expect(await deletedBranches(ctx)).toEqual({ "Year-3": tip });
  });

  it("won't take a name already in use", async () => {
    const ctx = await seeded();
    await createBranch({ ...ctx, name: "Year-3" });
    await checkoutBranch({ ...ctx, name: BRANCH });
    await createBranch({ ...ctx, name: "Year-4" });

    await expect(
      renameBranch({ ...ctx, from: "Year-3", to: "Year-4" }),
    ).rejects.toThrow();
  });
});
