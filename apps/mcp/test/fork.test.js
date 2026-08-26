// Forking a lesson and proposing changes back (src/git.js), against a fake hub.
//
// The point of these is the git, not the HTTP: the fake hub (test/fake-hub.js)
// stores packfiles the way the Worker's R2 bucket does, with the same
// compare-and-swap on write, so what's under test is whether the repository the
// assistant builds is a real clone — whether the proposal's pack shares ancestry
// with the lesson it targets. Without that a reviewer's three-way merge has no
// base and the whole flow degrades to "replace the lesson with mine".
//
// Committing an ordinary edit (recordLessonHistory) is tested in history.test.js,
// and the in-memory filesystem these repositories are built on in
// packages/core/src/git/memfs.test.js.

import assert from "node:assert/strict";
import test from "node:test";

import { memRepo } from "@spelling-creator/core/git/memfs";
import {
  cloneFromPack,
  contains,
  mergeBase,
} from "@spelling-creator/core/git/pack";
import { headOid, readDocAt } from "@spelling-creator/core/git/repo";

import {
  forkLesson,
  proposalBody,
  proposeChanges,
  recordLessonHistory,
} from "../src/git.js";
import { fakeHub, lessonDoc, seedLesson } from "./fake-hub.js";

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

  // The assistant edits its fork, and the edit's own history push fails — so the
  // fork's document is ahead of its repository, and proposing has to commit the
  // difference before it can offer anything.
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

test("a fork whose edits are already committed proposes those commits", async () => {
  // The ordinary path now: patch_lesson commits as it goes, so by propose time
  // the fork's history already holds the change and there is nothing left to
  // commit. Proposing has to offer what is there rather than insisting on one
  // more commit it cannot make.
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const { lesson: fork } = await forkLesson(hub.api, { lessonId: source.id });

  const edited = lessonDoc(
    "Volcanoes",
    "A volcano ERUPTS when MAGMA reaches the surface.",
  );
  const previousDoc = hub.lessons.get(fork.id).doc;
  hub.lessons.get(fork.id).doc = edited;
  const recorded = await recordLessonHistory(hub.api, {
    lessonId: fork.id,
    doc: edited,
    previousDoc,
    client: "Claude Desktop",
  });
  assert.equal(recorded.recorded, true);

  const result = await proposeChanges(hub.api, {
    forkLessonId: fork.id,
    title: "Explain what makes a volcano erupt",
  });

  assert.equal(result.pull.ready, true);
  // The proposal points at the commit the edit made, not at a fresh one built on
  // top of it — nothing was left to commit.
  assert.equal(result.commit, recorded.commit);
  // And the changes are stated against the lesson, not against the fork's own
  // last commit, which is what a reviewer is being asked to judge.
  assert.deepEqual(result.changes, ["- edit text block b1 (text)"]);

  const ctx = memRepo("review");
  await cloneFromPack({ ...ctx, ...hub.pullPacks.get(result.pull.id) });
  assert.equal(
    await contains({ ...ctx, oid: result.commit, ancestor: source.head }),
    true,
    "still a real clone of the lesson, so the merge has a base",
  );
});

test("proposing a fork that has not moved since its proposal is refused", async () => {
  const hub = fakeHub();
  const source = await seedLesson(hub, {
    title: "Volcanoes",
    text: "A volcano ERUPTS.",
  });
  const { lesson: fork } = await forkLesson(hub.api, { lessonId: source.id });
  hub.lessons.get(fork.id).doc.sections[0].blocks[0].text = "Revised.";
  await proposeChanges(hub.api, { forkLessonId: fork.id, title: "Revise" });

  // Nothing has happened to the fork since. Bumping the revision here would tell
  // the reviewer to re-read a diff that hasn't changed.
  await assert.rejects(
    proposeChanges(hub.api, { forkLessonId: fork.id, title: "Revise again" }),
    /already holds exactly these changes/,
  );
  assert.equal(hub.pulls[0].revision, undefined, "the proposal did not move");
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
