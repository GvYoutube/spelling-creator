// User-profile API — talks to the same `apps/api` Worker as the rest
// of the hub. Profiles are keyed by the Supabase user id (the `authorId` already
// carried on every lesson/comment), so a link stays valid even when a display
// name changes. The data lives under /profiles (not /users) so it doesn't collide
// with the SPA's /users/:id page — mirroring how lesson data is at /lessons while
// its page is at /hub.
//
// Worker endpoints (see handleUsers / handleFollow / handleFollowingFeed in
// apps/api/src/index.js):
//   GET    {API_URL}/profiles/:id           -> { user: { id, displayName, bio, followerCount, followingCount, isFollowing }, lessons: LessonSummary[] }
//   GET    {API_URL}/profiles/:id/feed.xml  -> Atom feed (surfaced as "RSS" in the UI)
//   POST   {API_URL}/profiles/:id/follow      -> { following: true,  followerCount }   (Bearer)
//   DELETE {API_URL}/profiles/:id/follow      -> { following: false, followerCount }   (Bearer)
//   GET    {API_URL}/profiles/:id/followers   -> { users: PublicUser[] }
//   GET    {API_URL}/profiles/:id/following   -> { users: PublicUser[] }
//   GET    {API_URL}/following/activity       -> { activity: FeedItem[] }              (Bearer)

const API_URL = import.meta.env.VITE_API_URL;

// Whether profiles can be fetched at all (needs a configured backend).
export const profilesEnabled = Boolean(API_URL);

const base = () => API_URL.replace(/\/$/, "");

/**
 * Fetch a user's public profile: their chosen display name, bio, follower/
 * following counts, and the lessons they've published (newest first). Public — no
 * auth required. Passing the caller's session token additionally resolves
 * `user.isFollowing` (whether *you* follow this profile), so the page can show the
 * right Follow / Following state.
 * @param {string} id            The user's Supabase id.
 * @param {string} [accessToken] Optional Supabase session JWT (for isFollowing).
 * @returns {Promise<{ user: { id, displayName, bio, followerCount, followingCount, isFollowing }, lessons: Array }>}
 */
export async function fetchUserProfile(id, accessToken) {
  if (!API_URL) throw new Error("Profiles are not configured.");
  if (!id) throw new Error("Missing user id.");

  let res;
  try {
    res = await fetch(`${base()}/profiles/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status}).`);
  }
  const data = await res.json().catch(() => ({}));
  const user = data.user || { id, displayName: "Anonymous", bio: "" };
  return {
    user: {
      followerCount: 0,
      followingCount: 0,
      isFollowing: false,
      ...user,
    },
    lessons: Array.isArray(data.lessons) ? data.lessons : [],
  };
}

/**
 * Follow (`follow: true`) or unfollow (`follow: false`) a user. Requires a signed-
 * in session. Following someone drops a notification into their bell. Resolves to
 * the server's `{ following, followerCount }` so the UI can update the button and
 * count without a refetch; throws an Error carrying the Worker's plain-text reason
 * on failure (e.g. trying to follow yourself).
 * @param {string} id           The user to (un)follow.
 * @param {boolean} follow       true to follow, false to unfollow.
 * @param {string} accessToken   Supabase session JWT.
 * @returns {Promise<{ following: boolean, followerCount: number }>}
 */
export async function setFollowing(id, follow, accessToken) {
  if (!API_URL) throw new Error("Profiles are not configured.");
  if (!id) throw new Error("Missing user id.");
  if (!accessToken) throw new Error("Please sign in to follow people.");

  let res;
  try {
    res = await fetch(`${base()}/profiles/${encodeURIComponent(id)}/follow`, {
      method: follow ? "POST" : "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status}).`);
  }
  const data = await res.json().catch(() => ({}));
  return {
    following: Boolean(data.following),
    followerCount:
      typeof data.followerCount === "number" ? data.followerCount : 0,
  };
}

/**
 * List a user's followers, or the users they follow. Public — no auth. Each entry
 * is a public profile shape ({ id, displayName, bio }), newest-follow first.
 * @param {string} id          The user whose connections to list.
 * @param {"followers"|"following"} direction  Which list to fetch.
 * @returns {Promise<Array<{ id, displayName, bio }>>}
 */
export async function fetchFollowList(id, direction) {
  if (!API_URL) throw new Error("Profiles are not configured.");
  if (!id) throw new Error("Missing user id.");
  const dir = direction === "followers" ? "followers" : "following";

  let res;
  try {
    res = await fetch(`${base()}/profiles/${encodeURIComponent(id)}/${dir}`, {
      method: "GET",
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status}).`);
  }
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.users) ? data.users : [];
}

/**
 * Fetch the signed-in user's "following" feed: recent lessons and comments from
 * everyone they follow, merged newest-first. Each item is { id, title, summary,
 * link, updated } — the same shape as {@link fetchUserActivity}, so it renders in
 * the dashboard's <FeedList> unchanged. Returns [] when the user follows no one.
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<Array<{ id, title, summary, link, updated }>>}
 */
export async function fetchFollowingActivity(accessToken) {
  if (!API_URL) throw new Error("Profiles are not configured.");
  if (!accessToken) return [];

  let res;
  try {
    res = await fetch(`${base()}/following/activity`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status}).`);
  }
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.activity) ? data.activity : [];
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
