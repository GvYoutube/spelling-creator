// Auto-persist the working lesson to localStorage so progress survives reloads.
const STORAGE_KEY = "s2c-lesson-maker:doc";
// The id of the published lesson currently being edited, persisted alongside
// the doc so the "editing a published lesson" status survives reloads and tab
// closes (cleared only by overwriting it or forking into a new lesson).
const EDITING_ID_KEY = "s2c-lesson-maker:editing-id";
// Set once the first-lesson wizard has been dismissed, so it doesn't reappear
// on every visit. Reopening it from the help button doesn't clear this — the
// wizard only auto-shows when the key is absent.
const WIZARD_SEEN_KEY = "s2c-lesson-maker:wizard-seen";

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

// Whether the first-lesson wizard has been dismissed before. Used to auto-show
// it only to newcomers; the help button opens it regardless of this flag.
export function loadWizardSeen() {
  try {
    return localStorage.getItem(WIZARD_SEEN_KEY) === "1";
  } catch {
    // Treat an unreadable store as "already seen" so we never nag in a loop.
    return true;
  }
}

export function saveWizardSeen() {
  try {
    localStorage.setItem(WIZARD_SEEN_KEY, "1");
  } catch {
    /* ignore — the wizard just shows again next visit */
  }
}
