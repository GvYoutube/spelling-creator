// Lesson-comment API — talks to the same `apps/api` Worker as the
// rest of the hub (see lessons.js). The browser never touches the database
// directly; it only calls these Worker endpoints.
//
// Worker endpoints this expects (see README "Lesson hub" for the full contract):
//   GET   {API_URL}/lessons/:id/comments      -> { comments: Comment[] }  (public)
//   POST  {API_URL}/lessons/:id/comments      -> { comment: Comment }     (auth: Bearer Supabase JWT)
//   PATCH {API_URL}/lessons/:id/comments/:cid -> { comment: Comment }     (auth: the comment's author)
//
// Comment: { id, parentId, authorId, author, body, createdAt, editedAt }
//   parentId is the comment this one replies to, or null for a top-level comment.
//   body is rich-text HTML (see lib/richText.js); comments predating rich text are
//   plain strings, which RichText.jsx still renders as plain text.
//   editedAt is when the author last edited it, or null if they never have.
//
// Posting is moderated server-side: a comment containing profanity is rejected
// outright (HTTP 422) and the Worker's plain-text reason is surfaced to the user.
// Editing runs the same gauntlet. A reply (parentId set) also notifies the parent
// comment's author and the lesson author — handled entirely server-side.
//
// A comment may also carry a 1–5 star `rating` for the lesson (see the MUI Rating
// in CommentsSection). The Worker stores one rating per user per lesson and, when
// a rating is included, returns the lesson's new average so the page can update
// its displayed stars. See postComment's return shape.

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

// Mirrors the Worker's MAX_COMMENT_LENGTH so the editor can show a live counter and
// refuse to submit an over-long comment. Counted over the text the user wrote, not
// the markup around it — the Worker measures the same way, so the two agree.
export const COMMENT_MAX = 2000;

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
 *
 * An optional 1–5 star `rating` rates the lesson alongside the comment; the
 * Worker stores one rating per user (re-rating updates it) and returns the
 * lesson's new average when a rating is included.
 * @param {string} lessonId
 * @param {string} body          The comment text.
 * @param {string} accessToken   Supabase session JWT.
 * @param {string} [parentId]    The comment being replied to; omit for a top-level comment.
 * @param {number} [rating]      A 1–5 star rating for the lesson; omit to comment without rating.
 * @returns {Promise<{comment: {id, parentId, author, body, createdAt}, rating: {average, count}|null}>}
 */
export async function postComment(
  lessonId,
  body,
  accessToken,
  parentId,
  rating,
) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!lessonId) throw new Error("Missing lesson id.");
  if (!accessToken) throw new Error("Please sign in before commenting.");

  const text = (body || "").trim();
  if (!text) throw new Error("Write something before posting.");

  const payload = { body: text };
  if (parentId) payload.parentId = parentId;
  if (rating != null) payload.rating = rating;

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
  return { comment: data.comment || {}, rating: data.rating || null };
}

/**
 * Edit one of your own comments. The Worker decides ownership from the verified JWT
 * against the stored row — the browser can't claim authorship of someone else's
 * comment — and re-runs the same sanitizing, length and profanity checks as a fresh
 * post, so an edit can't launder past a rule the original had to satisfy. The
 * returned comment carries `editedAt`, which the thread shows as an "edited" marker.
 *
 * Moderators deliberately have no edit power: they can delete a comment, but not
 * rewrite one under its author's name.
 *
 * @param {string} lessonId
 * @param {string} commentId   The comment to edit; must be yours.
 * @param {string} body        The new body, as rich-text HTML.
 * @param {string} accessToken Supabase session JWT.
 * @returns {Promise<{id, parentId, authorId, author, body, createdAt, editedAt}>}
 */
export async function updateComment(lessonId, commentId, body, accessToken) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!lessonId || !commentId) throw new Error("Missing comment id.");
  if (!accessToken) throw new Error("Please sign in before editing.");

  let res;
  try {
    res = await fetch(
      `${endpoint(lessonId)}/${encodeURIComponent(commentId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ body }),
      },
    );
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
