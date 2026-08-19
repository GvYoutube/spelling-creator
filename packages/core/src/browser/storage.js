// The lesson library: every lesson this device is holding, and which one is open.
//
// The editor used to keep exactly one working document — a `doc` key in
// IndexedDB, plus a handful of flags beside it saying which hub lesson it was
// attached to. That made "open this lesson" a destructive act: the only way to
// start something new, fork a lesson or import a document was to overwrite the
// draft already there, which is why the editor had a "Replace your current
// work?" dialog guarding three separate flows.
//
// IndexedDB has no reason to hold one lesson rather than fifty, so it holds as
// many as the user makes. A library record is the small stuff — title, counts,
// which hub lesson it's attached to, when it was last touched — and the document
// itself lives in its own store keyed by the same id (see imageStore.js for why
// the two are split). Each lesson also owns a git repository named by that same
// id while it is a local draft (see browser/git/fs.js and `repoIdFor`), so
// switching lessons switches histories too.
//
// Everything here is async — IndexedDB has no synchronous API. Callers await.
//
// Two migrations run once each, in order, on the editor's first mount:
//
//   migrateLocalStorage()  the pre-IndexedDB draft (localStorage, base64 images)
//                          -> the v1 IndexedDB doc + flags
//   migrateToLibrary()     that single doc + flags -> one library record
//
// Both are idempotent, and both are best-effort: a browser that refuses us
// storage still gets a working editor, it just won't remember anything.

import {
  loadDocument,
  saveDocument,
  clearDocument,
  loadEditingId,
  saveEditingId,
  loadEditingPublished,
  saveEditingPublished,
  loadForkedFrom,
  saveForkedFrom,
  loadWizardSeen,
  saveWizardSeen,
  listLessonRecords,
  getLessonRecord,
  putLessonRecord,
  deleteLessonRecord,
  getLessonDoc,
  putLessonDoc,
  deleteLessonDoc,
  loadCurrentLessonId,
  saveCurrentLessonId,
} from "./imageStore.js";
import { convertDocImages } from "./imageRef.js";
import { DRAFT_REPO } from "../git/doc.js";
import { newId } from "../id.js";

export { loadWizardSeen, saveWizardSeen };

// ---- the library -----------------------------------------------------------

/**
 * The metadata kept beside a lesson's document, derived from it on every save.
 *
 * Deliberately denormalised: the library list and the sidebar want a title and
 * a size for each lesson, and reading every document to work them out would
 * make listing the library cost as much as opening all of it.
 */
function statsFor(doc) {
  const sections = doc?.sections || [];
  let blocks = 0;
  for (const section of sections) blocks += (section.blocks || []).length;
  return {
    title: typeof doc?.title === "string" ? doc.title : "",
    sections: sections.length,
    blocks,
  };
}

/** Newest first — "what I was working on" is the order a library is read in. */
function byRecency(a, b) {
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

/** Every lesson on this device, newest first. Metadata only — no documents. */
export async function listLessons() {
  return (await listLessonRecords()).sort(byRecency);
}

/** One lesson, document included, or null if this device doesn't have it. */
export async function getLesson(id) {
  const record = await getLessonRecord(id);
  if (!record) return null;
  return { ...record, doc: await getLessonDoc(id) };
}

/**
 * Add a lesson to the library and return its record (document included).
 *
 * `id` is normally left to us. It is worth knowing what it becomes, though,
 * because it is also the name of the lesson's git repository until the lesson is
 * published and takes the hub's id instead — so a caller that wants to clone a
 * repository into a new lesson (a fork, an import) creates the record first and
 * clones into `record.id`.
 */
export async function createLesson({
  id = newId(),
  doc = { title: "", sections: [] },
  lessonId = null,
  published = true,
  forkedFrom = null,
} = {}) {
  const now = Date.now();
  const record = {
    id,
    ...statsFor(doc),
    lessonId,
    published,
    forkedFrom,
    createdAt: now,
    updatedAt: now,
  };
  // The document first: a record whose document hasn't landed yet would list a
  // lesson that opens empty, where the reverse is merely a document nothing
  // points at (and the next createLesson overwrites it).
  await putLessonDoc(id, doc);
  await putLessonRecord(record);
  return { ...record, doc };
}

/**
 * Store a lesson's document, refreshing the title and counts beside it.
 *
 * The record is read *first*, and a lesson that no longer has one is left alone
 * rather than half-written. The editor's document save is debounced, so a save
 * can still be in flight when its lesson is deleted; writing the document then
 * would leave a body in the store that nothing points at and nothing collects.
 */
export async function saveLessonDoc(id, doc) {
  if (!id) return null;
  const record = await getLessonRecord(id);
  if (!record) return null;
  await putLessonDoc(id, doc);
  const next = { ...record, ...statsFor(doc), updatedAt: Date.now() };
  await putLessonRecord(next);
  return next;
}

/**
 * Update the record's own fields — which hub lesson it's attached to, whether
 * that lesson is published, what it was forked from.
 *
 * Deliberately *not* stamped with updatedAt: these are consequences of saving to
 * the cloud rather than edits, and re-ordering the library because a lesson
 * learnt its own hub id would be noise.
 */
export async function saveLessonMeta(id, patch) {
  if (!id) return null;
  const record = await getLessonRecord(id);
  if (!record) return null;
  const next = { ...record, ...patch };
  await putLessonRecord(next);
  return next;
}

/**
 * Remove a lesson from the library. The caller deletes its git repository —
 * that lives in a different database (LightningFS) and needs the git engine
 * loaded, which this module deliberately doesn't pull in.
 */
export async function deleteLesson(id) {
  if (!id) return;
  await deleteLessonRecord(id);
  await deleteLessonDoc(id);
  if ((await loadCurrentLessonId()) === id) await saveCurrentLessonId(null);
}

/** The lesson the editor last had open, so a reload comes back to it. */
export async function getCurrentLessonId() {
  return loadCurrentLessonId();
}

export async function setCurrentLessonId(id) {
  return saveCurrentLessonId(id);
}

// ---- migrations ------------------------------------------------------------

// Legacy localStorage keys (pre-IndexedDB). Read once by migrateLocalStorage,
// then removed.
const LS_DOC = "s2c-lesson-maker:doc";
const LS_EDITING_ID = "s2c-lesson-maker:editing-id";
const LS_EDITING_PUBLISHED = "s2c-lesson-maker:editing-published";
const LS_WIZARD_SEEN = "s2c-lesson-maker:wizard-seen";
// Set once the migration has run, so we don't repeatedly poke localStorage.
const MIGRATED_FLAG = "s2c-lesson-maker:migrated-to-idb";

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// One-time move of the old localStorage draft into IndexedDB. Safe to call on
// every load: once the migrated flag is set (or the old keys are gone) it's a
// no-op. Run before hydrating editor state from IndexedDB.
export async function migrateLocalStorage() {
  let rawDoc;
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) return;
    rawDoc = localStorage.getItem(LS_DOC);
  } catch {
    return; // localStorage unavailable — nothing to migrate
  }

  try {
    // Move the small flags first (cheap, independent of the doc). Only seed each
    // when the old key is present, so we don't overwrite newer IndexedDB state.
    const editingId = safeGet(LS_EDITING_ID);
    if (editingId) await saveEditingId(editingId);
    const publishedFlag = safeGet(LS_EDITING_PUBLISHED);
    if (publishedFlag !== null) {
      await saveEditingPublished(publishedFlag !== "0");
    }
    if (safeGet(LS_WIZARD_SEEN) === "1") await saveWizardSeen();

    if (rawDoc) {
      const doc = JSON.parse(rawDoc);
      const converted = await convertDocImages(doc);
      // Don't clobber a doc already created in IndexedDB after a prior partial
      // migration; only seed when the IndexedDB doc is still empty.
      if (!(await loadDocument())) await saveDocument(converted);
    }

    for (const key of [
      LS_DOC,
      LS_EDITING_ID,
      LS_EDITING_PUBLISHED,
      LS_WIZARD_SEEN,
    ]) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    try {
      localStorage.setItem(MIGRATED_FLAG, "1");
    } catch {
      /* ignore */
    }
  } catch {
    // Best effort: leave the old keys in place so the next load can retry.
  }
}

/**
 * Move the single working document into the library, as its first lesson.
 *
 * The record takes the id `draft` on purpose. That is the name the old working
 * lesson's repository already has on disk (`/lessons/draft/.git` — see
 * browser/git/fs.js), and a library lesson's id *is* its repo id while it is
 * unpublished, so naming the record after the repository carries the history
 * across without copying a single git object. Lessons created from here on get
 * ordinary random ids, which cannot collide with it.
 *
 * A no-op once the library has anything in it, so it is safe on every load.
 */
export async function migrateToLibrary() {
  const existing = await listLessonRecords();
  if (existing.length > 0) {
    // Already a library. Make sure something is open — a device whose current
    // lesson was deleted in another tab shouldn't come back to nothing.
    const current = await loadCurrentLessonId();
    if (!current || !existing.some((record) => record.id === current)) {
      await saveCurrentLessonId(existing.sort(byRecency)[0].id);
    }
    return;
  }

  const doc = await loadDocument();
  if (!doc) return; // nothing was ever saved here — the editor starts fresh

  const [lessonId, published, forkedFrom] = await Promise.all([
    loadEditingId(),
    loadEditingPublished(),
    loadForkedFrom(),
  ]);

  await createLesson({
    id: DRAFT_REPO,
    doc,
    lessonId: lessonId || null,
    published,
    forkedFrom: forkedFrom || null,
  });
  await saveCurrentLessonId(DRAFT_REPO);

  // Only now drop the v1 keys: if anything above failed, the next load finds
  // them still there and tries again rather than losing the lesson.
  await clearDocument();
  await saveEditingId(null);
  await saveEditingPublished(null);
  await saveForkedFrom(null);
}
