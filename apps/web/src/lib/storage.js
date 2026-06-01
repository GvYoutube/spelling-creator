// Working-lesson persistence. Backed by IndexedDB (see imageStore.js) so images
// can be stored as binary blobs and large drafts aren't capped by localStorage's
// ~5 MB quota. These functions are async — callers await them.
//
// migrateLocalStorage() performs a one-time move of any pre-IndexedDB draft (the
// old localStorage keys, with base64 images inline) into IndexedDB, converting
// each inline image to a binary blob + hash ref. It is idempotent.

import {
  loadDocument,
  saveDocument,
  clearDocument,
  loadEditingId,
  saveEditingId,
  loadEditingPublished,
  saveEditingPublished,
  loadWizardSeen,
  saveWizardSeen,
} from "./imageStore.js";
import { convertDocImages } from "./imageRef.js";

export {
  loadDocument,
  saveDocument,
  clearDocument,
  loadEditingId,
  saveEditingId,
  loadEditingPublished,
  saveEditingPublished,
  loadWizardSeen,
  saveWizardSeen,
};

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
