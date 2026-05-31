// Hub search — queries the Algolia index the Worker keeps in sync (see the
// companion `spelling-creator-cf` Worker: it upserts a record on publish/update
// and removes it on delete). The browser searches Algolia directly with a
// *search-only* API key, which is safe to ship in the bundle — unlike the admin
// key, it can only read, and only this index.
//
// We pass the app id and key as query-string parameters (rather than the
// X-Algolia-* request headers) and let the body default to a text/plain
// content type. That keeps the request "simple" in CORS terms, so the browser
// skips the preflight OPTIONS round-trip — the same trick Algolia's own
// lightweight client uses.

const APP_ID = import.meta.env.VITE_ALGOLIA_APP_ID;
const SEARCH_KEY = import.meta.env.VITE_ALGOLIA_SEARCH_KEY;
const INDEX = import.meta.env.VITE_ALGOLIA_INDEX_NAME || "lessons";

// Whether search is configured at build time. When false the hub hides its
// search box and falls back to the plain newest-first listing.
export const algoliaEnabled = Boolean(APP_ID && SEARCH_KEY);

// How many hits to request. The hub shows them all in its grid; lessons number
// in the dozens, so a single page is plenty.
const HITS_PER_PAGE = 50;

/**
 * Search published lessons by title or author. Returns an array of lesson
 * summaries in the SAME shape as fetchPublishedLessons (id, authorId, title,
 * author, sectionCount, createdAt), so the hub can render the hits with the very
 * same cards — including the owner-only Edit/Delete actions, which key off
 * authorId.
 *
 * @param {string} query  The user's search text. Empty/whitespace returns [].
 * @returns {Promise<Array<{id, authorId, title, author, sectionCount, createdAt}>>}
 */
export async function searchLessons(query) {
  if (!algoliaEnabled) throw new Error("Search is not configured.");
  const q = (query || "").trim();
  if (!q) return [];

  const url =
    `https://${APP_ID}-dsn.algolia.net/1/indexes/${encodeURIComponent(INDEX)}/query` +
    `?x-algolia-application-id=${encodeURIComponent(APP_ID)}` +
    `&x-algolia-api-key=${encodeURIComponent(SEARCH_KEY)}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ query: q, hitsPerPage: HITS_PER_PAGE }),
    });
  } catch {
    throw new Error("Could not reach search.");
  }
  if (!res.ok) throw new Error("Search is unavailable right now.");

  const data = await res.json().catch(() => ({}));
  const hits = Array.isArray(data.hits) ? data.hits : [];
  // objectID is the lesson id; the rest of the record mirrors the card fields.
  return hits.map((h) => ({
    id: h.objectID,
    authorId: h.authorId,
    title: h.title,
    author: h.author,
    sectionCount: h.sectionCount,
    createdAt: h.createdAt,
  }));
}
