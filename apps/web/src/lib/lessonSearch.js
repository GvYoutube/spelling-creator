// Fully client-side lesson search, powered by lunr.js. The hub loads every
// published lesson summary up front (GET /lessons), so there's no need to hit a
// backend for search — we build a small in-memory lunr index over those
// summaries and rank them in the browser. This replaces the old Algolia
// integration with zero network calls and no API keys.
//
// Lesson summaries only carry `title` and `author` (not the full document), so
// those are the searchable fields. Title is boosted so a name match outranks an
// author match.

import lunr from "lunr";

/**
 * Build a lunr index over the given lesson summaries, plus a lookup from
 * document ref back to the original summary. Cheap enough to rebuild whenever
 * the lesson list changes (the hub has at most a few hundred lessons).
 *
 * @param {Array<{id: string, title?: string, author?: string}>} lessons
 * @returns {{ index: lunr.Index, byId: Map<string, object> }}
 */
export function buildLessonIndex(lessons) {
  const byId = new Map();
  for (const lesson of lessons) byId.set(lesson.id, lesson);

  const index = lunr(function () {
    this.ref("id");
    this.field("title", { boost: 10 });
    this.field("author");

    for (const lesson of lessons) {
      this.add({
        id: lesson.id,
        // Mirror the UI's fallbacks so a search for "untitled" or "anonymous"
        // finds the cards that display those placeholders.
        title: lesson.title || "Untitled Lesson",
        author: lesson.author || "Anonymous",
      });
    }
  });

  return { index, byId };
}

/**
 * Run a query against a built index and return the matching lesson summaries in
 * relevance order (best first). An empty/whitespace query returns null, letting
 * the caller fall back to its default (newest-first) listing.
 *
 * Each term is matched both exactly and as a prefix, so results appear as the
 * user types ("spel" matches "spelling") and a small edit distance is tolerated
 * to forgive typos. Lunr throws on some partial/malformed query syntax, so the
 * whole thing is guarded.
 *
 * @param {{ index: lunr.Index, byId: Map<string, object> }} built
 * @param {string} query
 * @returns {Array<object> | null}
 */
export function searchLessons(built, query) {
  if (!built) return null;
  const trimmed = (query || "").trim();
  if (!trimmed) return null;

  const terms = trimmed.split(/\s+/).filter(Boolean);

  let results;
  try {
    results = built.index.query((q) => {
      for (const term of terms) {
        // Exact match (highest weight).
        q.term(term, { boost: 3 });
        // Prefix match for as-you-type results ("spel" -> "spelling").
        q.term(term, { boost: 2, wildcard: lunr.Query.wildcard.TRAILING });
        // Single-edit fuzzy match to forgive small typos, but only for terms
        // long enough that fuzziness won't match almost everything.
        if (term.length > 3) q.term(term, { editDistance: 1 });
      }
    });
  } catch {
    return [];
  }

  return results.map((r) => built.byId.get(r.ref)).filter(Boolean);
}
