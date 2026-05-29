// Auto-persist the working lesson to localStorage so progress survives reloads.
const STORAGE_KEY = "s2c-lesson-maker:doc";

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
    // Quota errors (large images) are non-fatal — the in-memory doc still works.
  }
}

export function clearDocument() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
