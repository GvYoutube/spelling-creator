// Fully client-side lesson search, powered by Fuse.js. The hub loads every
// published lesson summary up front (GET /lessons), so there's no need to hit a
// backend for search — we build a small in-memory Fuse index over those
// summaries and rank them in the browser. This replaces the old Algolia
// integration with zero network calls and no API keys.
//
// Lesson summaries only carry `title` and `author` (not the full document), so
// those are the searchable fields. Title is weighted higher so a name match
// outranks an author match.

import Fuse from "fuse.js";

// Fuse is fuzzy by default, which covers both as-you-type prefix matches
// ("spel" -> "spelling") and small typos in one pass. `ignoreLocation` lets a
// match land anywhere in the field (not just near the start), and the threshold
// is kept fairly tight so results stay relevant rather than matching almost
// everything.
const FUSE_OPTIONS = {
  includeScore: false,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 2,
  keys: [
    { name: "title", weight: 2 },
    { name: "author", weight: 1 },
  ],
};

/**
 * Build a Fuse index over the given lesson summaries. Cheap enough to rebuild
 * whenever the lesson list changes (the hub has at most a few hundred lessons).
 *
 * @param {Array<{id: string, title?: string, author?: string}>} lessons
 * @returns {Fuse<object>}
 */
export function buildLessonIndex(lessons) {
  // Index entries mirror the UI's fallbacks so a search for "untitled" or
  // "anonymous" finds the cards that display those placeholders. The original
  // summary is carried along so callers get it back unchanged.
  const entries = lessons.map((lesson) => ({
    title: lesson.title || "Untitled Lesson",
    author: lesson.author || "Anonymous",
    lesson,
  }));

  return new Fuse(entries, FUSE_OPTIONS);
}

/**
 * Run a query against a built index and return the matching lesson summaries in
 * relevance order (best first). An empty/whitespace query returns null, letting
 * the caller fall back to its default (newest-first) listing.
 *
 * @param {Fuse<object>} index
 * @param {string} query
 * @returns {Array<object> | null}
 */
export function searchLessons(index, query) {
  if (!index) return null;
  const trimmed = (query || "").trim();
  if (!trimmed) return null;

  return index.search(trimmed).map((result) => result.item.lesson);
}
