// User-profile API — talks to the same `spelling-creator-cf` Worker as the rest
// of the hub. Profiles are keyed by the Supabase user id (the `authorId` already
// carried on every lesson/comment), so a link stays valid even when a display
// name changes. The data lives under /profiles (not /users) so it doesn't collide
// with the SPA's /users/:id page — mirroring how lesson data is at /lessons while
// its page is at /hub.
//
// Worker endpoints (see handleUsers in apps/api/src/index.js):
//   GET {API_URL}/profiles/:id           -> { user: { id, displayName, bio }, lessons: LessonSummary[] }
//   GET {API_URL}/profiles/:id/feed.xml  -> Atom feed (surfaced as "RSS" in the UI)

const API_URL = import.meta.env.VITE_API_URL;

// Whether profiles can be fetched at all (needs a configured backend).
export const profilesEnabled = Boolean(API_URL);

/**
 * Fetch a user's public profile: their chosen display name, bio, and the lessons
 * they've published (newest first). Public — no auth required.
 * @param {string} id  The user's Supabase id.
 * @returns {Promise<{ user: { id, displayName, bio }, lessons: Array }>}
 */
export async function fetchUserProfile(id) {
  if (!API_URL) throw new Error("Profiles are not configured.");
  if (!id) throw new Error("Missing user id.");

  let res;
  try {
    res = await fetch(
      `${API_URL.replace(/\/$/, "")}/profiles/${encodeURIComponent(id)}`,
      { method: "GET" },
    );
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status}).`);
  }
  const data = await res.json().catch(() => ({}));
  return {
    user: data.user || { id, displayName: "Anonymous", bio: "" },
    lessons: Array.isArray(data.lessons) ? data.lessons : [],
  };
}

/**
 * The absolute URL of a user's Atom activity feed, for the "RSS" subscribe link.
 * Returns "" when no backend is configured.
 * @param {string} id  The user's Supabase id.
 * @returns {string}
 */
export function userFeedUrl(id) {
  if (!API_URL || !id) return "";
  return `${API_URL.replace(/\/$/, "")}/profiles/${encodeURIComponent(id)}/feed.xml`;
}
