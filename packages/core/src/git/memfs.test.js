// The in-memory filesystem is only worth anything if isomorphic-git accepts it,
// so these tests drive the real engine over it — commit, pack, clone, merge base
// — rather than checking readFile round-trips. That is the whole contract: the
// MCP server's fork-and-propose flow (apps/mcp/src/git.js) is exactly this
// sequence, with the packs travelling over HTTP in between.

import { describe, expect, it } from "vitest";
import { memFs, memRepo } from "./memfs.js";
import { commitDoc, headOid, readDocAt } from "./repo.js";
import { cloneFromPack, contains, mergeBase, packRepo } from "./pack.js";

const author = { name: "Test", email: "test@example.com" };

function doc(title, text) {
  return {
    title,
    sections: [
      { id: "s1", name: "One", blocks: [{ id: "b1", type: "text", text }] },
    ],
  };
}

describe("memFs", () => {
  it("looks like node:fs to isomorphic-git", () => {
    const fs = memFs();
    // isomorphic-git detects the promise API with getOwnPropertyDescriptor and
    // falls back to callback style when it isn't an own data property.
    const descriptor = Object.getOwnPropertyDescriptor(fs, "promises");
    expect(descriptor?.value).toBeTruthy();
    for (const method of [
      "readFile",
      "writeFile",
      "unlink",
      "readdir",
      "mkdir",
      "rmdir",
      "stat",
      "lstat",
      "readlink",
      "symlink",
    ]) {
      expect(typeof fs.promises[method]).toBe("function");
    }
  });

  it("reports a missing file as ENOENT", async () => {
    const fs = memFs();
    await expect(fs.promises.readFile("/nope")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.promises.stat("/nope")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lists only a directory's direct children", async () => {
    const fs = memFs();
    await fs.promises.mkdir("/a", { recursive: true });
    await fs.promises.mkdir("/a/b", { recursive: true });
    await fs.promises.writeFile("/a/one.txt", "1");
    await fs.promises.writeFile("/a/b/two.txt", "2");

    expect(await fs.promises.readdir("/a")).toEqual(["b", "one.txt"]);
    expect(await fs.promises.readdir("/a/b")).toEqual(["two.txt"]);
  });

  it("round-trips bytes and text", async () => {
    const fs = memFs();
    await fs.promises.writeFile("/hello", "héllo");
    expect(await fs.promises.readFile("/hello", "utf8")).toBe("héllo");
    expect(await fs.promises.readFile("/hello")).toBeInstanceOf(Uint8Array);
  });

  it("refuses to remove a directory that still has something in it", async () => {
    const fs = memFs();
    await fs.promises.mkdir("/a", { recursive: true });
    await fs.promises.writeFile("/a/one.txt", "1");
    await expect(fs.promises.rmdir("/a")).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
    await fs.promises.unlink("/a/one.txt");
    await fs.promises.rmdir("/a");
    expect(await fs.promises.readdir("/")).toEqual([]);
  });
});

describe("the git engine on an in-memory repo", () => {
  it("commits a document and reads it back", async () => {
    const ctx = memRepo();
    const first = await commitDoc({
      ...ctx,
      doc: doc("Volcanoes", "Lava"),
      author,
    });

    expect(first?.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(await headOid(ctx)).toBe(first.oid);
    expect(await readDocAt({ ...ctx, oid: first.oid })).toMatchObject({
      title: "Volcanoes",
    });
  });

  it("does not commit an unchanged document twice", async () => {
    const ctx = memRepo();
    await commitDoc({ ...ctx, doc: doc("Volcanoes", "Lava"), author });
    const again = await commitDoc({
      ...ctx,
      doc: doc("Volcanoes", "Lava"),
      author,
    });
    expect(again).toBeNull();
  });

  it("packs a history and clones it into a fork that shares ancestry", async () => {
    // The original: two commits, packed for upload exactly as the Worker stores it.
    const origin = memRepo("origin");
    await commitDoc({ ...origin, doc: doc("Rivers", "Source"), author });
    const forkPoint = await commitDoc({
      ...origin,
      doc: doc("Rivers", "Source to sea"),
      author,
    });
    const packed = await packRepo(origin);
    expect(packed.head).toBe(forkPoint.oid);

    // The fork: a genuine clone, so the same commit oids and the same content.
    const fork = memRepo("fork");
    await cloneFromPack({ ...fork, ...packed });
    expect(await headOid(fork)).toBe(packed.head);
    expect(await readDocAt({ ...fork, oid: packed.head })).toMatchObject({
      title: "Rivers",
    });

    // What the assistant proposes: one commit on top of the clone.
    const proposal = await commitDoc({
      ...fork,
      doc: doc("Rivers", "Source to sea, and the delta"),
      author,
    });

    // And the ancestry that makes a reviewer's three-way merge real.
    expect(
      await contains({ ...fork, oid: proposal.oid, ancestor: packed.head }),
    ).toBe(true);
    expect(
      await mergeBase({ ...fork, ours: proposal.oid, theirs: packed.head }),
    ).toBe(packed.head);
  });

  it("keeps two in-memory repos out of each other's way", async () => {
    const a = memRepo();
    const b = memRepo();
    await commitDoc({ ...a, doc: doc("A", "a"), author });
    expect(await headOid(b)).toBeNull();
  });
});
