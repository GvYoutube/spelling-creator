// Committing an assistant's edits into a lesson's version history
// (recordLessonHistory in src/git.js), against the fake hub.
//
// The hub keeps a lesson's document and a lesson's repository in two separate
// stores, and saving the document writes only the first. So every one of these
// asks the same question from a different angle: after the tool has saved, does
// the lesson's History tab actually say what happened? Before this existed it
// said nothing at all, however much an assistant had rewritten.
//
// Forking and proposing are tested in fork.test.js.

import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { memRepo } from "@spelling-creator/core/git/memfs";
import { cloneFromPack, packRepo } from "@spelling-creator/core/git/pack";
import {
  commitDoc,
  createBranch,
  headOid,
  history,
  readDocAt,
} from "@spelling-creator/core/git/repo";

import { recordLessonHistory } from "../src/git.js";
import { registerTools, SERVER_INFO } from "../src/tools.js";
import { AUTHOR, fakeHub, lessonDoc, seedLesson } from "./fake-hub.js";

/** The lesson's stored history, newest first, read back the way a fork would. */
async function storedHistory(hub, lessonId) {
  const stored = hub.packs.get(lessonId);
  if (!stored) return [];
  const ctx = memRepo("read");
  await cloneFromPack({ ...ctx, ...stored });
  return history(ctx);
}

/** The document the lesson's stored history holds at its tip. */
async function storedDoc(hub, lessonId) {
  const stored = hub.packs.get(lessonId);
  const ctx = memRepo("read");
  await cloneFromPack({ ...ctx, ...stored });
  return readDocAt({ ...ctx, oid: stored.head });
}

test("an edit made over MCP becomes a commit on the lesson", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });

  const edited = lessonDoc(
    "Volcanoes",
    "A volcano ERUPTS when MAGMA reaches the surface.",
  );
  const result = await recordLessonHistory(hub.api, {
    lessonId: source.id,
    doc: edited,
    previousDoc: source.doc,
    client: "Claude Desktop",
  });

  assert.equal(result.recorded, true);
  assert.equal(result.caughtUp, false, "the history was already up to date");
  assert.equal(result.seeded, false);

  const log = await storedHistory(hub, source.id);
  assert.equal(log.length, 2, "one new commit on top of the lesson's own");
  assert.equal(log[0].oid, result.commit);
  assert.equal(log[1].oid, source.head, "built on the lesson, not beside it");
  assert.equal(log[0].summary, "Edit 1 text block");
  assert.equal(result.summary, "Edit 1 text block");

  assert.match(
    (await storedDoc(hub, source.id)).sections[0].blocks[0].text,
    /MAGMA/,
  );
});

test("the commit says an assistant made it, and which client it came through", async () => {
  // The hub attributes the commit to the account whose token this is, so without
  // the note the user reads their own name against changes they did not write.
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });

  await recordLessonHistory(hub.api, {
    lessonId: source.id,
    doc: lessonDoc("Volcanoes", "A volcano ERUPTS, throwing out LAVA."),
    previousDoc: source.doc,
    client: "claude.ai",
  });

  const [latest] = await storedHistory(hub, source.id);
  assert.equal(latest.author, AUTHOR.name, "signed as the account");
  assert.match(latest.message, /AI assistant/);
  assert.match(latest.message, /claude\.ai/);
  // The itemised operations are still in there for the history detail view.
  assert.match(latest.message, /- edit text block b1/);
});

test("a lesson whose document ran ahead of its history catches up first", async () => {
  // What every lesson edited over MCP before this existed looks like: content in
  // the row that no commit accounts for. Folding it into the assistant's commit
  // would attribute changes to an edit that didn't make them.
  const hub = fakeHub();
  const drift = lessonDoc("Volcanoes", "A volcano ERUPTS. Written elsewhere.");
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
    drift,
  });

  const edited = lessonDoc("Volcanoes", "MAGMA rises until a volcano ERUPTS.");
  const result = await recordLessonHistory(hub.api, {
    lessonId: source.id,
    doc: edited,
    previousDoc: drift,
  });

  assert.equal(result.recorded, true);
  assert.equal(result.caughtUp, true);

  const log = await storedHistory(hub, source.id);
  assert.equal(log.length, 3);
  assert.match(log[1].summary, /^Record the lesson as it was last saved/);

  const ctx = memRepo("read");
  await cloneFromPack({ ...ctx, ...hub.packs.get(source.id) });
  // The catch-up commit holds the drift, so the assistant's commit on top of it
  // is exactly the edit and nothing else.
  assert.match(
    (await readDocAt({ ...ctx, oid: log[1].oid })).sections[0].blocks[0].text,
    /Written elsewhere/,
  );
  assert.match(
    (await readDocAt({ ...ctx, oid: log[0].oid })).sections[0].blocks[0].text,
    /^MAGMA rises/,
  );
});

test("a lesson with no stored history has one started from its previous content", async () => {
  const hub = fakeHub();
  const previousDoc = lessonDoc("Rivers", "A river FLOWS.");
  hub.lessons.set("plain", {
    id: "plain",
    title: "Rivers",
    doc: previousDoc,
    published: true,
    forkedFrom: null,
  });

  const edited = lessonDoc("Rivers", "A river FLOWS down to the SEA.");
  const result = await recordLessonHistory(hub.api, {
    lessonId: "plain",
    doc: edited,
    previousDoc,
  });

  assert.equal(result.recorded, true);
  assert.equal(result.seeded, true, "the lesson had no history at all");

  const log = await storedHistory(hub, "plain");
  assert.equal(log.length, 2, "the starting point, then the edit");
  assert.equal(log[1].parents.length, 0, "and that starting point is the root");
  assert.match(
    (await storedDoc(hub, "plain")).sections[0].blocks[0].text,
    /SEA/,
  );
});

test("a brand-new lesson's first commit is the lesson arriving", async () => {
  const hub = fakeHub();
  const doc = lessonDoc("Rivers", "A river FLOWS.");
  const lesson = await hub.api.createLesson({ title: "Rivers", doc });

  const result = await recordLessonHistory(hub.api, {
    lessonId: lesson.id,
    doc,
    summary: 'Create "Rivers"',
  });

  assert.equal(result.recorded, true);
  const log = await storedHistory(hub, lesson.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].summary, 'Create "Rivers"');
});

test("an edit that changes nothing the history stores commits nothing", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });

  const result = await recordLessonHistory(hub.api, {
    lessonId: source.id,
    doc: source.doc,
    previousDoc: source.doc,
  });

  assert.equal(result.recorded, false);
  assert.equal(result.reason, "unchanged");
  assert.equal(
    hub.packs.get(source.id).head,
    source.head,
    "an empty commit is not an improvement on no commit",
  );
});

test("a lesson that moved on beneath us is reported, not thrown", async () => {
  // The document is already saved by the time this runs, and nothing here can
  // unsave it — so a conflict is news to pass on, not a failure to raise.
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  hub.api.pushLessonPack = async () => {
    throw new Error(
      "This lesson’s history has moved on since you last synced.",
    );
  };

  const result = await recordLessonHistory(hub.api, {
    lessonId: source.id,
    doc: lessonDoc("Volcanoes", "A volcano ERUPTS, throwing out LAVA."),
    previousDoc: source.doc,
  });

  assert.equal(result.recorded, false);
  assert.match(result.reason, /moved on/);
  assert.equal(hub.packs.get(source.id).head, source.head);
});

test("a lesson's variations survive an edit made over MCP", async () => {
  // A push that named only the lesson's own branch would leave the hub
  // advertising a variation whose objects the stored pack no longer holds.
  const hub = fakeHub();
  const doc = lessonDoc("Volcanoes", "A volcano ERUPTS.");
  hub.lessons.set("multi", {
    id: "multi",
    title: "Volcanoes",
    doc,
    published: true,
    forkedFrom: null,
  });

  const ctx = memRepo("seed");
  const first = await commitDoc({ ...ctx, doc, author: AUTHOR });
  await createBranch({ ...ctx, name: "Year-3", from: first.oid });
  const variation = await commitDoc({
    ...ctx,
    doc: lessonDoc("Volcanoes", "A volcano ERUPTS. (Year 3)"),
    author: AUTHOR,
  });
  const packed = await packRepo(ctx);
  hub.packs.set("multi", {
    packfile: packed.packfile,
    head: packed.head,
    refs: packed.refs,
  });

  const result = await recordLessonHistory(hub.api, {
    lessonId: "multi",
    doc: lessonDoc("Volcanoes", "MAGMA rises until a volcano ERUPTS."),
    previousDoc: doc,
  });

  assert.equal(result.recorded, true);
  const stored = hub.packs.get("multi");
  assert.equal(stored.refs["Year-3"], variation.oid, "the variation is intact");
  assert.equal(stored.head, result.commit, "and the lesson moved forward");

  // Intact means clonable, not merely advertised: the pack has to carry the
  // objects the variation's tip needs.
  const check = memRepo("check");
  await cloneFromPack({ ...check, ...stored });
  assert.equal(
    await headOid({ ...check, ref: "refs/heads/Year-3" }),
    variation.oid,
  );
});

// ---- The tools themselves ---------------------------------------------------

/** An MCP client wired to the tools, running against a fake hub. */
async function connect(hub) {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, {
    api: hub.api,
    config: { apiUrl: "https://example.test" },
  });
  const client = new Client({ name: "Claude Desktop", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      assert.equal(res.isError, undefined, res.content?.[0]?.text);
      return JSON.parse(res.content[0].text);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test("create_lesson starts the lesson's version history", async () => {
  const hub = fakeHub();
  const mcp = await connect(hub);

  const result = await mcp.call("create_lesson", {
    title: "Rivers",
    sections: [{ name: "Reading", blocks: [{ type: "text", text: "FLOWS." }] }],
    skipValidation: true,
  });

  assert.equal(result.history.recorded, true);
  const log = await storedHistory(hub, result.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].summary, 'Create "Rivers"');
  assert.match(log[0].message, /Claude Desktop/);

  await mcp.close();
});

test("patch_lesson commits the edit it saves", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const mcp = await connect(hub);

  const result = await mcp.call("patch_lesson", {
    id: source.id,
    operations: [
      {
        op: "replace_block",
        blockId: "b1",
        block: { type: "text", text: "MAGMA rises until a volcano ERUPTS." },
      },
    ],
    skipValidation: true,
  });

  assert.equal(result.history.recorded, true);
  assert.equal(result.history.summary, "Edit 1 text block");
  const log = await storedHistory(hub, source.id);
  assert.equal(log.length, 2);
  assert.equal(log[0].oid, result.history.commit);
  assert.match(
    (await storedDoc(hub, source.id)).sections[0].blocks[0].text,
    /^MAGMA rises/,
  );

  await mcp.close();
});

test("update_lesson commits the replacement over what was there", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const mcp = await connect(hub);

  const result = await mcp.call("update_lesson", {
    id: source.id,
    title: "Volcanoes",
    sections: [
      { name: "Reading", blocks: [{ type: "text", text: "MAGMA rises." }] },
    ],
    skipValidation: true,
  });

  assert.equal(result.history.recorded, true);
  const log = await storedHistory(hub, source.id);
  assert.equal(log[1].oid, source.head, "built on the lesson's own history");
  assert.equal(
    (await storedDoc(hub, source.id)).sections[0].blocks[0].text,
    "MAGMA rises.",
  );

  await mcp.close();
});

test("a write whose history could not be recorded says so in its result", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  hub.api.pushLessonPack = async () => {
    throw new Error("R2 is having a moment.");
  };
  const mcp = await connect(hub);

  const result = await mcp.call("patch_lesson", {
    id: source.id,
    operations: [{ op: "set_title", title: "Volcanoes and magma" }],
    skipValidation: true,
  });

  // The edit itself stands — the row was written before any of this.
  assert.equal(hub.lessons.get(source.id).doc.title, "Volcanoes and magma");
  assert.equal(result.history.recorded, false);
  assert.match(result.history.note, /History tab/);
  assert.match(result.history.note, /R2 is having a moment/);

  await mcp.close();
});
