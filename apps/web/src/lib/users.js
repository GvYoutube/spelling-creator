// User-profile API — talks to the same `apps/api` Worker as the rest
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

// Pull the trimmed text of the first descendant with the given local name
// (namespace-agnostic, so the Atom default xmlns doesn't get in the way).
function entryText(el, tag) {
  const node = el.getElementsByTagNameNS("*", tag)[0];
  return node ? (node.textContent || "").trim() : "";
}

/**
 * Fetch a user's recent activity for the in-page activity menu. Rather than add a
 * second backend route, this reads the very same Atom feed the "RSS" button points
 * at and parses it client-side with DOMParser — so the Worker only maintains the
 * one feed.xml endpoint.
 * @param {string} id  The user's Supabase id.
 * @returns {Promise<Array<{ id, title, summary, updated, link }>>} Newest first.
 */
export async function fetchUserActivity(id) {
  const url = userFeedUrl(id);
  if (!url) throw new Error("Profiles are not configured.");

  let res;
  try {
    res = await fetch(url, { method: "GET" });
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);

  const doc = new DOMParser().parseFromString(
    await res.text(),
    "application/xml",
  );
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("Could not read the activity feed.");
  }

  return Array.from(doc.getElementsByTagNameNS("*", "entry")).map((entry) => {
    const links = Array.from(entry.getElementsByTagNameNS("*", "link"));
    const alternate =
      links.find((l) => l.getAttribute("rel") === "alternate") || links[0];
    return {
      id: entryText(entry, "id"),
      title: entryText(entry, "title"),
      summary: entryText(entry, "summary"),
      updated: entryText(entry, "updated"),
      link: alternate ? alternate.getAttribute("href") || "" : "",
    };
  });
}
