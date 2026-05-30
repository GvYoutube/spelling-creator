// Lesson-hub API — talks to the companion `spelling-creator-cf` Worker, which
// owns the Supabase Postgres connection. The browser never touches the database
// directly; it only ever calls these Worker endpoints (mirroring how aiSuggest
// and pixabay already proxy through the same Worker).
//
// Worker endpoints this expects (see README "Lesson hub" for the full contract):
//   GET  {API_URL}/lessons          -> { lessons: LessonSummary[] }   (public)
//   GET  {API_URL}/lessons/:id      -> { lesson: Lesson }             (public)
//   POST {API_URL}/lessons          -> { lesson: LessonSummary }      (auth: Bearer Supabase JWT)
//   PUT  {API_URL}/lessons/:id      -> { lesson: LessonSummary }      (auth: Bearer; author only)
//   DELETE {API_URL}/lessons/:id    -> { ok: true }                   (auth: Bearer; author only)
//
// LessonSummary: { id, authorId, title, author, sectionCount, createdAt }
// Lesson:        LessonSummary & { doc }   where `doc` is the editor document
//                shape { title, sections: [...] } used everywhere else.
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
 * Fetch a single published lesson, including its full editor `doc`. Public.
 * @param {string} id
 * @returns {Promise<{id, title, author, createdAt, doc}>}
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
 * Publish the current editor document to the shared hub. Requires a signed-in
 * Supabase session: the access token is sent as a Bearer credential and the
 * Worker verifies it (and derives the author) before inserting the row.
 * @param {object} doc          The editor document ({ title, sections }).
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<{id, title, author, createdAt}>}
 */
export async function publishLesson(doc, accessToken) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!accessToken) throw new Error("Please sign in before publishing.");
  if (!doc || !Array.isArray(doc.sections) || doc.sections.length === 0) {
    throw new Error("Add at least one section before publishing.");
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
 * Update a lesson the signed-in user previously published. Requires a Supabase
 * session JWT; the Worker only applies the change when the verified user is the
 * lesson's author (otherwise it responds 403). Overwrites the published title and
 * doc with the supplied document.
 * @param {string} id           The id of the lesson to update.
 * @param {object} doc          The editor document ({ title, sections }).
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<{id, authorId, title, author, sectionCount, createdAt}>}
 */
export async function updateLesson(id, doc, accessToken) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!id) throw new Error("Missing lesson id.");
  if (!accessToken) throw new Error("Please sign in before editing.");
  if (!doc || !Array.isArray(doc.sections) || doc.sections.length === 0) {
    throw new Error("Add at least one section before saving.");
  }

  let res;
  try {
    res = await fetch(endpoint(`/${encodeURIComponent(id)}`), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        title: doc.title || "Untitled Lesson",
        doc,
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
