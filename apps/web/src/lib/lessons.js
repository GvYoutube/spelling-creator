// Lesson-hub API — talks to the companion `apps/api` Worker, which
// owns the Supabase Postgres connection. The browser never touches the database
// directly; it only ever calls these Worker endpoints (mirroring how aiSuggest
// and pixabay already proxy through the same Worker).
//
// Worker endpoints this expects (see README "Lesson hub" for the full contract):
//   GET  {API_URL}/lessons          -> { lessons: LessonSummary[] }   (public; published only)
//   GET  {API_URL}/lessons/mine     -> { lessons: LessonSummary[] }   (auth: Bearer; caller's own, incl. drafts)
//   GET  {API_URL}/lessons/:id      -> { lesson: Lesson }             (public)
//   POST {API_URL}/lessons          -> { lesson: LessonSummary }      (auth: Bearer Supabase JWT)
//   PUT  {API_URL}/lessons/:id      -> { lesson: LessonSummary }      (auth: Bearer; author only)
//   DELETE {API_URL}/lessons/:id    -> { ok: true }                   (auth: Bearer; author only)
//
// LessonSummary: { id, authorId, title, author, sectionCount, published, createdAt }
//                `published` is false for a draft — a lesson backed up to the
//                database but kept out of the public hub listing.
// Lesson:        LessonSummary & { doc, avgRating, ratingCount }
//                `doc` is the editor document shape { title, sections: [...] } used
//                everywhere else. `avgRating` is the mean of its 1–5 star ratings
//                (null when unrated) and `ratingCount` how many it has — shown on
//                the lesson page (see CommentsSection for how ratings are left).
//                `authorId` is the publisher's Supabase user id — the hub compares
//                it with the signed-in user to decide whether to offer "Edit".

const API_URL = import.meta.env.VITE_API_URL;

// sessionStorage key the hub uses to hand the editor the id of a lesson to open
// for editing. The hub sets it then navigates to the editor, which consumes and
// clears it once on mount (see HubPage.editLesson / EditorPage's load effect).
export const EDIT_REQUEST_KEY = "s2c-lesson-maker:edit-lesson-id";

// sessionStorage key the lesson page uses to hand the editor the id of a lesson
// to fork: the editor loads its document as a fresh, unattached draft (no
// editingId), so publishing creates a new lesson rather than touching the
// original. Unlike editing, forking needs no special permission — the original
// row is never modified. Consumed and cleared once on the editor's mount.
export const FORK_REQUEST_KEY = "s2c-lesson-maker:fork-lesson-id";

// Whether the hub can reach a backend at all. Browsing needs only this; the
// publish step additionally needs a signed-in Supabase session.
export const lessonHubEnabled = Boolean(API_URL);

function endpoint(path = "") {
  // Tolerate a trailing slash on VITE_API_URL.
  return `${API_URL.replace(/\/$/, "")}/lessons${path}`;
}

/**
 * The absolute URL of the hub's "latest lessons" Atom feed, for the "RSS"
 * subscribe link on the hub. Served by the Worker at /feed.xml (a site-wide feed,
 * not under /lessons). Returns "" when no backend is configured.
 * @returns {string}
 */
export function lessonsFeedUrl() {
  if (!API_URL) return "";
  return `${API_URL.replace(/\/$/, "")}/feed.xml`;
}

// Pull the trimmed text of the first descendant with the given local name
// (namespace-agnostic, so the Atom default xmlns doesn't get in the way). Mirrors
// the helper in lib/users.js used for the per-user activity feed.
function entryText(el, tag) {
  const node = el.getElementsByTagNameNS("*", tag)[0];
  return node ? (node.textContent || "").trim() : "";
}

/**
 * Fetch the hub's "latest lessons" Atom feed and parse it client-side with
 * DOMParser — the same approach lib/users.js uses for a user's activity feed, so
 * the Worker only maintains the one feed.xml endpoint. The homepage dashboard
 * renders these for signed-in users. Each entry's <link rel="alternate"> points
 * at the lesson's /hub/:id page.
 * @returns {Promise<Array<{ id, title, author, summary, updated, link }>>} Newest first.
 */
export async function fetchLatestLessons() {
  const url = lessonsFeedUrl();
  if (!url) throw new Error("The lesson hub is not configured.");

  let res;
  try {
    res = await fetch(url, { method: "GET" });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);

  const doc = new DOMParser().parseFromString(
    await res.text(),
    "application/xml",
  );
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("Could not read the latest-lessons feed.");
  }

  return Array.from(doc.getElementsByTagNameNS("*", "entry")).map((entry) => {
    const links = Array.from(entry.getElementsByTagNameNS("*", "link"));
    const alternate =
      links.find((l) => l.getAttribute("rel") === "alternate") || links[0];
    return {
      id: entryText(entry, "id"),
      title: entryText(entry, "title"),
      author: entryText(entry, "author"),
      summary: entryText(entry, "summary"),
      updated: entryText(entry, "updated"),
      link: alternate ? alternate.getAttribute("href") || "" : "",
    };
  });
}

async function readError(res) {
  // The Worker returns a plain-text reason for 4xx/5xx; surface it directly.
  const detail = await res.text().catch(() => "");
  return new Error(detail || `Request failed (${res.status}).`);
}

/**
 * List published lessons, newest first. Public — no auth required.
 * @returns {Promise<Array<{id, title, author, sectionCount, createdAt}>>}
 */
export async function fetchPublishedLessons() {
  if (!API_URL) throw new Error("The lesson hub is not configured.");

  let res;
  try {
    res = await fetch(endpoint(), { method: "GET" });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.lessons) ? data.lessons : [];
}

/**
 * List the signed-in user's own lessons (drafts and published), newest first.
 * Requires a Supabase session JWT. Used by the hub to show a user their drafts,
 * which are excluded from the public listing.
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<Array<{id, authorId, title, author, sectionCount, published, createdAt}>>}
 */
export async function fetchMyLessons(accessToken) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!accessToken) throw new Error("Please sign in to see your lessons.");

  let res;
  try {
    res = await fetch(endpoint("/mine"), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.lessons) ? data.lessons : [];
}

/**
 * Fetch a single lesson, including its full editor `doc`. Public for published
 * lessons; an author can also load their own draft by id (e.g. to edit it).
 * @param {string} id
 * @returns {Promise<{id, title, author, sectionCount, published, createdAt, doc, avgRating, ratingCount}>}
 */
export async function fetchLesson(id) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!id) throw new Error("Missing lesson id.");

  let res;
  try {
    res = await fetch(endpoint(`/${encodeURIComponent(id)}`), {
      method: "GET",
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  if (!data.lesson) throw new Error("Lesson not found.");
  return data.lesson;
}

/**
 * Save the current editor document to the cloud as a new lesson. Requires a
 * signed-in Supabase session: the access token is sent as a Bearer credential and
 * the Worker verifies it (and derives the author) before inserting the row.
 * `published` chooses whether the lesson is shared on the public hub (true,
 * the default) or kept as a private draft backup (false).
 * @param {object} doc          The editor document ({ title, sections }).
 * @param {string} accessToken  Supabase session JWT.
 * @param {{ published?: boolean, forkedFrom?: string }} [opts]
 *        `forkedFrom` is the id of the lesson this one was forked from, when it
 *        was. The server records it so the fork can later pull the original's
 *        changes in — see lib/git/sync.js.
 * @returns {Promise<{id, title, author, sectionCount, published, forkedFrom, createdAt}>}
 */
export async function publishLesson(
  doc,
  accessToken,
  { published = true, forkedFrom = null } = {},
) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!accessToken) throw new Error("Please sign in before saving.");
  if (!doc || !Array.isArray(doc.sections) || doc.sections.length === 0) {
    throw new Error("Add at least one section before saving.");
  }

  let res;
  try {
    res = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        title: doc.title || "Untitled Lesson",
        doc,
        published,
        ...(forkedFrom ? { forkedFrom } : {}),
      }),
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return data.lesson || {};
}

/**
 * Update a lesson the signed-in user previously saved to the cloud. Requires a
 * Supabase session JWT; the Worker only applies the change when the verified user
 * is the lesson's author (otherwise it responds 403). Overwrites the stored title
 * and doc with the supplied document. When `published` is given, it also flips the
 * lesson between draft and hub-published; omit it to leave the current state alone.
 * @param {string} id           The id of the lesson to update.
 * @param {object} doc          The editor document ({ title, sections }).
 * @param {string} accessToken  Supabase session JWT.
 * @param {{ published?: boolean }} [opts]
 * @returns {Promise<{id, authorId, title, author, sectionCount, published, createdAt}>}
 */
export async function updateLesson(id, doc, accessToken, { published } = {}) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!id) throw new Error("Missing lesson id.");
  if (!accessToken) throw new Error("Please sign in before editing.");
  if (!doc || !Array.isArray(doc.sections) || doc.sections.length === 0) {
    throw new Error("Add at least one section before saving.");
  }

  const body = {
    title: doc.title || "Untitled Lesson",
    doc,
  };
  // Only send `published` when explicitly chosen, so an update that isn't meant to
  // change visibility leaves the lesson's current draft/published state untouched.
  if (typeof published === "boolean") body.published = published;

  let res;
  try {
    res = await fetch(endpoint(`/${encodeURIComponent(id)}`), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return data.lesson || {};
}

/**
 * Permanently delete a lesson the signed-in user previously published. Requires
 * a Supabase session JWT; the Worker only deletes the row when the verified user
 * is the lesson's author (otherwise it responds 403). This cannot be undone.
 * @param {string} id           The id of the lesson to delete.
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<void>}
 */
export async function deleteLesson(id, accessToken) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!id) throw new Error("Missing lesson id.");
  if (!accessToken) throw new Error("Please sign in before deleting.");

  let res;
  try {
    res = await fetch(endpoint(`/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);
}
