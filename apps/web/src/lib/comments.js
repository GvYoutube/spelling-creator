// Lesson-comment API — talks to the same `apps/api` Worker as the
// rest of the hub (see lessons.js). The browser never touches the database
// directly; it only calls these Worker endpoints.
//
// Worker endpoints this expects (see README "Lesson hub" for the full contract):
//   GET  {API_URL}/lessons/:id/comments  -> { comments: Comment[] }  (public)
//   POST {API_URL}/lessons/:id/comments  -> { comment: Comment }     (auth: Bearer Supabase JWT)
//
// Comment: { id, parentId, author, body, createdAt }
//   parentId is the comment this one replies to, or null for a top-level comment.
//
// Posting is moderated server-side: a comment containing profanity is rejected
// outright (HTTP 422) and the Worker's plain-text reason is surfaced to the user.
// A reply (parentId set) also notifies the parent comment's author and the lesson
// author — handled entirely server-side.

const API_URL = import.meta.env.VITE_API_URL;

function endpoint(lessonId) {
  // Tolerate a trailing slash on VITE_API_URL.
  return `${API_URL.replace(/\/$/, "")}/lessons/${encodeURIComponent(lessonId)}/comments`;
}

async function readError(res) {
  // The Worker returns a plain-text reason for 4xx/5xx; surface it directly.
  const detail = await res.text().catch(() => "");
  const err = new Error(detail || `Request failed (${res.status}).`);
  // Expose the status so callers can distinguish cases — notably the 422 the
  // Worker returns when a comment is blocked for profanity (see postComment).
  err.status = res.status;
  return err;
}

// The Worker rejects a profanity-containing comment with this status (nothing is
// stored). The UI treats it as a moderation warning rather than an error.
export const COMMENT_BLOCKED_STATUS = 422;

/**
 * List the comments on a published lesson, oldest first. Public — no auth.
 * @param {string} lessonId
 * @returns {Promise<Array<{id, author, body, createdAt}>>}
 */
export async function fetchComments(lessonId) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!lessonId) throw new Error("Missing lesson id.");

  let res;
  try {
    res = await fetch(endpoint(lessonId), { method: "GET" });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.comments) ? data.comments : [];
}

/**
 * Post a comment on a published lesson. Requires a signed-in Supabase session:
 * the access token is sent as a Bearer credential and the Worker verifies it
 * (and derives the author) before inserting the row. The Worker also rejects the
 * comment if it contains profanity.
 * @param {string} lessonId
 * @param {string} body          The comment text.
 * @param {string} accessToken   Supabase session JWT.
 * @param {string} [parentId]    The comment being replied to; omit for a top-level comment.
 * @returns {Promise<{id, parentId, author, body, createdAt}>}
 */
export async function postComment(lessonId, body, accessToken, parentId) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!lessonId) throw new Error("Missing lesson id.");
  if (!accessToken) throw new Error("Please sign in before commenting.");

  const text = (body || "").trim();
  if (!text) throw new Error("Write something before posting.");

  const payload = { body: text };
  if (parentId) payload.parentId = parentId;

  let res;
  try {
    res = await fetch(endpoint(lessonId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return data.comment || {};
}

/**
 * Delete any comment as a moderator/admin. Privileged: the Worker verifies the
 * caller's role (re-derived from the database) before removing the row, and its
 * replies cascade with it. A plain author can't reach this — it's a moderation
 * action, distinct from the (not-yet-implemented) author self-delete.
 * @param {string} commentId
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<void>}
 */
export { deleteCommentAsMod as deleteComment } from "./moderation.js";
