// Forking a lesson and proposing changes back (src/git.js), against a fake hub.
//
// The point of these is the git, not the HTTP: the fake hub stores packfiles the
// way the Worker's R2 bucket does (bytes plus a head, with the same
// compare-and-swap on write), so what's under test is whether the repository the
// assistant builds is a real clone — whether the proposal's pack shares ancestry
// with the lesson it targets. Without that a reviewer's three-way merge has no
// base and the whole flow degrades to "replace the lesson with mine".
//
// The in-memory filesystem those repositories are built on is tested in
// packages/core/src/git/memfs.test.js.

import assert from "node:assert/strict";
import test from "node:test";

import { memRepo } from "@spelling-creator/core/git/memfs";
import {
  cloneFromPack,
  contains,
  mergeBase,
  packRepo,
} from "@spelling-creator/core/git/pack";
import { commitDoc, headOid, readDocAt } from "@spelling-creator/core/git/repo";

import { forkLesson, proposalBody, proposeChanges } from "../src/git.js";

const AUTHOR = { name: "Teacher", email: "teacher@example.com" };

function lessonDoc(title, text) {
  return {
    title,
    sections: [
      {
        id: "s1",
        name: "Reading",
        blocks: [
          { id: "b1", type: "text", text },
          { id: "b2", type: "spelling", words: ["BECAUSE", "FRIEND"] },
        ],
      },
    ],
  };
}

/**
 * A stand-in for the hub: lesson rows, packfiles keyed by lesson id, and
 * proposals. Records every call so a test can assert on what was sent, and
 * enforces the two rules the real Worker enforces — the pack compare-and-swap,
 * and a proposal's pack matching the head it was opened with.
 */
function fakeHub() {
  const lessons = new Map();
  const packs = new Map();
  const pullPacks = new Map();
  const pulls = [];
  let nextId = 1;

  const clone = (value) => JSON.parse(JSON.stringify(value));

  const api = {
    async whoami() {
      return { id: "u1", email: AUTHOR.email, displayName: AUTHOR.name };
    },

    async getLesson(id) {
      const lesson = lessons.get(id);
      if (!lesson) throw new Error("Lesson not found.");
      return clone(lesson);
    },

    async createLesson({ title, doc, published, forkedFrom }) {
      const id = `lesson-${nextId++}`;
      const lesson = {
        id,
        title,
        doc: clone(doc),
        published: Boolean(published),
        forkedFrom: forkedFrom || null,
      };
      lessons.set(id, lesson);
      // The real POST /lessons returns the row without its document.
      const { doc: _omitted, ...row } = lesson;
      return row;
    },

    async fetchLessonPack(id) {
      const pack = packs.get(id);
      return pack ? { packfile: pack.packfile, head: pack.head } : null;
    },

    async fetchLessonHead(id) {
      return packs.get(id)?.head || null;
    },

    async pushLessonPack(id, { packfile, head, parent }) {
      const current = packs.get(id);
      // The Worker's compare-and-swap: refuse a push built on a head that is no
      // longer the lesson's, because accepting it would drop someone's commits.
      if ((current?.head || null) !== (parent || null)) {
        throw new Error(
          "This lesson’s history has moved on since you last synced.",
        );
      }
      packs.set(id, { packfile, head });
      return { head };
    },

    async createPull(lessonId, fields) {
      const pull = {
        id: `pull-${nextId++}`,
        lessonId,
        status: "open",
        ready: false,
        ...fields,
      };
      pulls.push(pull);
      return clone(pull);
    },

    async listPulls(lessonId) {
      return {
        pulls: pulls.filter((p) => p.lessonId === lessonId).map(clone),
        canReview: false,
      };
    },

    // Mirrors the Worker's planPullUpload: the first upload has to match the head
    // the row was opened with; a later one records a revision.
    async uploadPullPack(lessonId, pullId, { packfile, head }) {
      const pull = pulls.find((p) => p.id === pullId);
      if (!pull) throw new Error("Proposal not found.");
      if (pull.ready) {
        assert.notEqual(head, pull.head, "an update has to actually move");
        pull.previousHead = pull.head;
        pull.head = head;
        pull.revision = (pull.revision || 1) + 1;
      } else {
        assert.equal(
          head,
          pull.head,
          "the pack must match the head opened with",
        );
        pull.ready = true;
      }
      pullPacks.set(pullId, { packfile, head });
      return clone(pull);
    },

    async closePull(lessonId, pullId) {
      const pull = pulls.find((p) => p.id === pullId);
      if (pull) pull.status = "closed";
      pullPacks.delete(pullId);
      return pull ? clone(pull) : null;
    },
  };

  return { api, lessons, packs, pullPacks, pulls };
}

/** Seed a lesson that has a real published history, as the editor leaves it. */
async function seedLesson(hub, { id = "original", title, text }) {
  const doc = lessonDoc(title, text);
  hub.lessons.set(id, {
    id,
    title,
    doc,
    published: true,
    forkedFrom: null,
  });

  const ctx = memRepo("seed");
  const first = await commitDoc({ ...ctx, doc, author: AUTHOR });
  const packed = await packRepo(ctx);
  hub.packs.set(id, { packfile: packed.packfile, head: packed.head });
  return { id, doc, head: first.oid };
}

test("forking clones the lesson's history under a new private draft", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });

  const { lesson, head, clonedHistory } = await forkLesson(hub.api, {
    lessonId: source.id,
  });

  assert.equal(clonedHistory, true);
  assert.equal(lesson.published, false, "a fork starts as a private draft");
  assert.equal(lesson.forkedFrom, source.id, "a fork keeps its pointer home");
  assert.equal(
    head,
    source.head,
    "an unedited fork sits on the original's own commit, so nothing was rewritten",
  );

  // The fork's history is stored under its own id, and is a genuine clone.
  const stored = hub.packs.get(lesson.id);
  assert.ok(stored, "the fork's history was pushed");
  const ctx = memRepo("check");
  await cloneFromPack({ ...ctx, ...stored });
  assert.equal(await headOid(ctx), source.head);
  assert.deepEqual(
    (await readDocAt({ ...ctx, oid: source.head })).sections[0].blocks[0].text,
    "A volcano ERUPTS.",
  );
});

test("a fork whose history can't be stored says so, and keeps the draft", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  hub.api.pushLessonPack = async () => {
    throw new Error("R2 is having a moment.");
  };

  // The row is created before the history is pushed, so a failed push leaves a
  // fork that nothing can be proposed from. Say that, rather than letting it be
  // rediscovered at propose time.
  await assert.rejects(
    forkLesson(hub.api, { lessonId: source.id }),
    /could not be stored.*Delete it and fork again/s,
  );

  // The draft itself is a real copy of the document and the user's to keep or
  // remove, so it is not deleted behind their back.
  assert.equal(hub.lessons.size, 2, "the fork's row is still there");
  const fork = [...hub.lessons.values()].find((l) => l.id !== source.id);
  assert.equal(fork.forkedFrom, source.id);
  assert.equal(hub.packs.has(fork.id), false, "and it has no history");
});

test("forking reads the history before the document", async () => {
  // A lesson being saved in the browser pushes its history first and its document
  // second, so reading the document first could pair an old document with a new
  // pack — and the reconciliation commit would then revert the save it raced.
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });

  const calls = [];
  const { fetchLessonPack, getLesson } = hub.api;
  hub.api.fetchLessonPack = async (id) => {
    calls.push("pack");
    return fetchLessonPack(id);
  };
  hub.api.getLesson = async (id) => {
    calls.push("doc");
    return getLesson(id);
  };

  await forkLesson(hub.api, { lessonId: source.id });
  assert.deepEqual(calls.slice(0, 2), ["pack", "doc"]);
});

test("forking a lesson with no stored history seeds one from its document", async () => {
  const hub = fakeHub();
  hub.lessons.set("plain", {
    id: "plain",
    title: "Rivers",
    doc: lessonDoc("Rivers", "A river FLOWS."),
    published: true,
    forkedFrom: null,
  });

  const { lesson, head, clonedHistory } = await forkLesson(hub.api, {
    lessonId: "plain",
  });

  assert.equal(clonedHistory, false, "there was nothing to clone");
  assert.ok(head, "the fork still has a history of its own");
  assert.ok(hub.packs.get(lesson.id));
});

test("a fork's title is renamed in both its document and its history", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });

  const { lesson, head } = await forkLesson(hub.api, {
    lessonId: source.id,
    title: "Volcanoes (revised)",
  });

  assert.notEqual(head, source.head, "renaming is a commit of its own");
  assert.equal(hub.lessons.get(lesson.id).doc.title, "Volcanoes (revised)");

  const ctx = memRepo("check");
  await cloneFromPack({ ...ctx, ...hub.packs.get(lesson.id) });
  assert.equal(
    (await readDocAt({ ...ctx, oid: head })).title,
    "Volcanoes (revised)",
  );
  // Still a descendant of the original, so it can still be merged back.
  assert.equal(
    await contains({ ...ctx, oid: head, ancestor: source.head }),
    true,
  );
});

test("proposing sends a pack that shares ancestry with the target lesson", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const { lesson: fork } = await forkLesson(hub.api, { lessonId: source.id });

  // The assistant edits its fork — the ordinary patch_lesson path, which saves
  // the document without committing anything.
  hub.lessons.get(fork.id).doc.sections[0].blocks[0].text =
    "A volcano ERUPTS when MAGMA reaches the surface.";

  const result = await proposeChanges(hub.api, {
    forkLessonId: fork.id,
    title: "Explain what makes a volcano erupt",
    body: "The first paragraph asserted the eruption without giving its cause.",
    client: "Claude Desktop",
  });

  assert.equal(
    result.lessonId,
    source.id,
    "proposed to the lesson forked from",
  );
  assert.equal(result.pull.ready, true, "the pack landed");
  assert.equal(result.pull.sourceLessonId, fork.id);
  assert.equal(
    result.pull.base,
    source.head,
    "records the tip it was built on",
  );
  assert.equal(result.pull.head, result.commit);
  assert.deepEqual(result.changes, ["- edit text block b1 (text)"]);

  // The provenance reaches the proposal a reviewer actually reads: on a
  // self-proposal it is the only thing saying they didn't write this.
  assert.match(result.pull.body, /Claude Desktop/);
  assert.match(result.pull.body, /AI assistant/);
  assert.match(result.pull.body, /without giving its cause/);

  // Nothing was written to the lesson itself — the whole guarantee of the flow.
  assert.equal(hub.packs.get(source.id).head, source.head);
  assert.equal(
    hub.lessons.get(source.id).doc.sections[0].blocks[0].text,
    "A volcano ERUPTS.",
  );

  // The proposal's pack is a real clone plus one commit, so a reviewer merging it
  // gets a three-way merge against the commit the two histories diverged from.
  const uploaded = hub.pullPacks.get(result.pull.id);
  assert.ok(uploaded, "the proposal carries its changes");
  const ctx = memRepo("review");
  await cloneFromPack({ ...ctx, ...uploaded });
  assert.equal(
    await contains({ ...ctx, oid: uploaded.head, ancestor: source.head }),
    true,
  );
  assert.equal(
    await mergeBase({ ...ctx, ours: uploaded.head, theirs: source.head }),
    source.head,
  );
  assert.match(
    (await readDocAt({ ...ctx, oid: uploaded.head })).sections[0].blocks[0]
      .text,
    /MAGMA/,
  );

  // And the fork's own history moved forward with it, so proposing again builds
  // on this commit rather than remaking it.
  assert.equal(hub.packs.get(fork.id).head, uploaded.head);
});

test("proposing twice updates the proposal already open, rather than stacking one beside it", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const { lesson: fork } = await forkLesson(hub.api, { lessonId: source.id });

  hub.lessons.get(fork.id).doc.sections[0].blocks[0].text = "First revision.";
  const first = await proposeChanges(hub.api, {
    forkLessonId: fork.id,
    title: "First pass",
  });
  assert.equal(first.updated, false);

  hub.lessons.get(fork.id).doc.sections[0].blocks[0].text = "Second revision.";
  const second = await proposeChanges(hub.api, {
    forkLessonId: fork.id,
    title: "Second pass",
  });

  assert.equal(
    second.updated,
    true,
    "the second call updates rather than opens",
  );
  assert.equal(hub.pulls.length, 1, "the reviewer sees one proposal, not two");
  assert.equal(second.pull.id, first.pull.id);
  assert.equal(second.pull.revision, 2);
  // Its title is the one the reviewer has been reading; an update doesn't rewrite
  // the conversation it belongs to.
  assert.equal(second.pull.title, "First pass");
  assert.notEqual(second.commit, first.commit);

  // The update builds on what the proposal already contained, which is the rule
  // that keeps one pack per proposal enough — the earlier commit is still in it.
  const ctx = memRepo("review");
  await cloneFromPack({ ...ctx, ...hub.pullPacks.get(second.pull.id) });
  assert.equal(
    await contains({ ...ctx, oid: second.commit, ancestor: first.commit }),
    true,
  );
});

test("a proposal that has been resolved is not updated — the next one is its own", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const { lesson: fork } = await forkLesson(hub.api, { lessonId: source.id });

  hub.lessons.get(fork.id).doc.sections[0].blocks[0].text = "First revision.";
  const first = await proposeChanges(hub.api, {
    forkLessonId: fork.id,
    title: "First pass",
  });
  await hub.api.closePull(source.id, first.pull.id);

  hub.lessons.get(fork.id).doc.sections[0].blocks[0].text = "Second revision.";
  const second = await proposeChanges(hub.api, {
    forkLessonId: fork.id,
    title: "Second pass",
  });

  assert.equal(second.updated, false);
  assert.notEqual(second.pull.id, first.pull.id);
  assert.equal(second.pull.title, "Second pass");
});

test("proposing an unchanged fork is refused, and opens nothing", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const { lesson: fork } = await forkLesson(hub.api, { lessonId: source.id });

  await assert.rejects(
    proposeChanges(hub.api, { forkLessonId: fork.id, title: "Nothing" }),
    /nothing to propose/,
  );
  assert.equal(hub.pulls.length, 0, "no empty request was left behind");
});

test("a proposal whose pack fails to upload is withdrawn, not left empty", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const { lesson: fork } = await forkLesson(hub.api, { lessonId: source.id });
  hub.lessons.get(fork.id).doc.sections[0].blocks[0].text = "Revised.";

  hub.api.uploadPullPack = async () => {
    throw new Error("R2 is having a moment.");
  };

  await assert.rejects(
    proposeChanges(hub.api, { forkLessonId: fork.id, title: "Revise" }),
    /R2 is having a moment/,
  );
  assert.equal(hub.pulls.length, 1);
  assert.equal(
    hub.pulls[0].status,
    "closed",
    "an unreviewable request must not sit in someone's queue",
  );
});

test("a failed proposal can be retried without editing the fork again", async () => {
  // The fork's history is pushed only after the proposal has landed. Pushing it
  // first would leave the fork's document equal to its own history, so the retry
  // would find nothing pending and refuse — the changes safe but unproposable.
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const { lesson: fork } = await forkLesson(hub.api, { lessonId: source.id });
  const forkHead = hub.packs.get(fork.id).head;
  hub.lessons.get(fork.id).doc.sections[0].blocks[0].text = "Revised.";

  // First attempt: the proposal itself fails.
  const { createPull } = hub.api;
  hub.api.createPull = async () => {
    throw new Error("The hub is having a moment.");
  };
  await assert.rejects(
    proposeChanges(hub.api, { forkLessonId: fork.id, title: "Revise" }),
    /The hub is having a moment/,
  );
  assert.equal(
    hub.packs.get(fork.id).head,
    forkHead,
    "the fork's history did not move, so the edit is still pending",
  );

  // Second attempt: it works, with no further edit to the fork.
  hub.api.createPull = createPull;
  const result = await proposeChanges(hub.api, {
    forkLessonId: fork.id,
    title: "Revise",
  });
  assert.equal(result.pull.ready, true);
  assert.equal(result.historyPushed, true);

  const ctx = memRepo("review");
  await cloneFromPack({ ...ctx, ...hub.pullPacks.get(result.pull.id) });
  const proposed = await readDocAt({ ...ctx, oid: result.commit });
  assert.match(proposed.sections[0].blocks[0].text, /Revised/);
});

test("a proposal still stands when the fork's own history can't be updated", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const { lesson: fork } = await forkLesson(hub.api, { lessonId: source.id });
  hub.lessons.get(fork.id).doc.sections[0].blocks[0].text = "Revised.";

  hub.api.pushLessonPack = async () => {
    throw new Error("R2 is having a moment.");
  };

  // The proposal's changes are stored with the proposal, so it is complete and
  // reviewable regardless — this is bookkeeping, and must not fail the call.
  const result = await proposeChanges(hub.api, {
    forkLessonId: fork.id,
    title: "Revise",
  });
  assert.equal(result.pull.ready, true);
  assert.equal(result.historyPushed, false, "reported, not thrown");
  assert.ok(hub.pullPacks.get(result.pull.id));
});

test("proposing from a lesson that is not a fork says so", async () => {
  const hub = fakeHub();
  await seedLesson(hub, { id: "solo", title: "Solo", text: "Alone." });

  await assert.rejects(
    proposeChanges(hub.api, { forkLessonId: "solo", title: "Change" }),
    /not a fork of anything/,
  );
});

test("proposing from a lesson with no history points back at fork_lesson", async () => {
  const hub = fakeHub();
  hub.lessons.set("draft", {
    id: "draft",
    title: "Draft",
    doc: lessonDoc("Draft", "Text."),
    published: false,
    forkedFrom: "original",
  });

  await assert.rejects(
    proposeChanges(hub.api, { forkLessonId: "draft", title: "Change" }),
    /no stored history/,
  );
});

test("a proposal's body records that an assistant wrote it", () => {
  assert.match(
    proposalBody("Because the answer was wrong.", "claude.ai"),
    /claude\.ai/,
  );
  assert.match(proposalBody("", ""), /AI assistant/);
  // The note survives a body long enough to need trimming — it's the provenance.
  const long = proposalBody("x".repeat(6000), "Cursor");
  assert.ok(long.length <= 4000);
  assert.match(long, /Cursor/);
});
