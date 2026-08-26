// A stand-in for the hub, shared by the tests that exercise src/git.js.
//
// Not a test file — it holds no tests of its own. It lives here because what it
// models is the half of the Worker the git flows actually depend on: lesson rows,
// packfiles stored the way the R2 bucket stores them (bytes plus a head plus a
// branch map), the compare-and-swap those writes are guarded by, and proposals.
// Getting those rules right in the fake is the whole point — a fake that accepted
// any push would let a caller that had stopped checking pass.

import assert from "node:assert/strict";

import { memRepo } from "@spelling-creator/core/git/memfs";
import { packRepo } from "@spelling-creator/core/git/pack";
import { DEFAULT_BRANCH } from "@spelling-creator/core/git/refs";
import { commitDoc } from "@spelling-creator/core/git/repo";

export const AUTHOR = { name: "Teacher", email: "teacher@example.com" };

/** A minimal but structurally real lesson document. */
export function lessonDoc(title, text) {
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
 * Lesson rows, packfiles keyed by lesson id, and proposals. Records every call so
 * a test can assert on what was sent, and enforces the rules the real Worker
 * enforces — the pack compare-and-swap (per lesson and per branch), and a
 * proposal's pack matching the head it was opened with.
 */
export function fakeHub() {
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

    async updateLesson(id, { title, doc, published }) {
      const lesson = lessons.get(id);
      if (!lesson) throw new Error("Lesson not found.");
      lesson.title = title;
      lesson.doc = clone(doc);
      if (typeof published === "boolean") lesson.published = published;
      const { doc: _omitted, ...row } = lesson;
      return row;
    },

    async fetchLessonPack(id) {
      const pack = packs.get(id);
      if (!pack) return null;
      return { packfile: pack.packfile, head: pack.head, refs: pack.refs };
    },

    async fetchLessonHead(id) {
      return packs.get(id)?.head || null;
    },

    async pushLessonPack(id, { packfile, head, parent, refs, expected }) {
      const current = packs.get(id);
      // The Worker's compare-and-swap: refuse a push built on a head that is no
      // longer the lesson's, because accepting it would drop someone's commits.
      if ((current?.head || null) !== (parent || null)) {
        throw new Error(
          "This lesson’s history has moved on since you last synced.",
        );
      }

      // And the same rule per branch, so a push that forgot one of a lesson's
      // variations is caught here rather than silently dropping it (see
      // applyRefs in apps/api/src/routes/git.js).
      const held = current?.refs || {};
      const next = { ...held };
      const claimed = expected || {};
      for (const [name, oid] of Object.entries(refs || {})) {
        const believed = Object.hasOwn(claimed, name) ? claimed[name] : null;
        const mismatch =
          believed === null
            ? Boolean(held[name])
            : (held[name] || "") !== believed;
        if (mismatch) {
          throw new Error("One of this lesson’s versions has moved on.");
        }
        next[name] = oid;
      }
      if (!refs) next[DEFAULT_BRANCH] = head;

      packs.set(id, { packfile, head, refs: next });
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
      // The Worker refuses an upload to a proposal that is no longer open, and a
      // fake that accepted one would hide a caller that had stopped checking.
      if (pull.status !== "open")
        throw new Error("This proposal is no longer open.");
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

/**
 * Seed a lesson that has a real published history, as the editor leaves it.
 *
 * `drift` is a document to store on the row *without* committing it, which is the
 * state a lesson is left in by a save whose history push failed — and by every
 * MCP edit made before those edits were committed.
 */
export async function seedLesson(hub, { id = "original", title, text, drift }) {
  const doc = lessonDoc(title, text);
  hub.lessons.set(id, {
    id,
    title,
    doc: drift || doc,
    published: true,
    forkedFrom: null,
  });

  const ctx = memRepo("seed");
  const first = await commitDoc({ ...ctx, doc, author: AUTHOR });
  const packed = await packRepo(ctx);
  hub.packs.set(id, {
    packfile: packed.packfile,
    head: packed.head,
    refs: packed.refs,
  });
  return { id, doc, head: first.oid };
}
