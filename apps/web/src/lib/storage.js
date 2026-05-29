// Auto-persist the working lesson to localStorage so progress survives reloads.
const STORAGE_KEY = "s2c-lesson-maker:doc";
// The id of the published lesson currently being edited, persisted alongside
// the doc so the "editing a published lesson" status survives reloads and tab
// closes (cleared only by overwriting it or forking into a new lesson).
const EDITING_ID_KEY = "s2c-lesson-maker:editing-id";

export function loadDocument() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveDocument(doc) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch {
    // Quota errors (large images) are non-fatal, the in-memory doc still works.
  }
}

export function clearDocument() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadEditingId() {
  try {
    return localStorage.getItem(EDITING_ID_KEY) || null;
  } catch {
    return null;
  }
}

// Persist the editing-published status. A falsy id removes the key, so the next
// load restores a "publishing a fresh lesson" state.
export function saveEditingId(id) {
  try {
    if (id) localStorage.setItem(EDITING_ID_KEY, id);
    else localStorage.removeItem(EDITING_ID_KEY);
  } catch {
    /* ignore */
  }
}
