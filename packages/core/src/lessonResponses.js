// Saved answers from interactive mode — the private record of a learner working
// through a lesson. Talks to the same `apps/api` Worker as the rest of the hub
// (see lessons.js); the browser never touches the database directly.
//
// Worker endpoints this expects:
//   GET    {apiUrl()}/lessons/:id/responses      -> { responses: LessonResponse[] }  (auth: Bearer; the caller's own only)
//   POST   {apiUrl()}/lessons/:id/responses      -> { response: LessonResponse }     (auth: Bearer)
//   DELETE {apiUrl()}/lessons/:id/responses/:rid -> { ok: true }                     (auth: Bearer; the caller's own only)
//
// LessonResponse: { id, lessonId, answers, completedAt }
//   `answers` is the array collectResponses() builds (see interactive.js): one
//   entry per question, each carrying a snapshot of the prompt it answered.
//
// **These are private.** Every endpoint requires a signed-in session and the
// Worker scopes each query to the verified user's own rows — a lesson's author,
// a moderator and an admin all have exactly as much access to someone's answers
// as a stranger does, which is none. There is deliberately no listing endpoint
// that returns anyone else's, so there is no route to add a "see who answered
// what" screen without changing the server contract first.
//
// For the same reason answers are never moderated: nobody but their author ever
// reads them, so there is nothing to moderate them for.
import { apiUrl, hasApi } from "./config.js";
import { validateResponses } from "./interactive.js";

function endpoint(lessonId) {
  return `${apiUrl()}/lessons/${encodeURIComponent(lessonId)}/responses`;
}

async function readError(res) {
  // The Worker returns a plain-text reason for 4xx/5xx; surface it directly.
  const detail = await res.text().catch(() => "");
  const err = new Error(detail || `Request failed (${res.status}).`);
  err.status = res.status;
  return err;
}

/**
 * List your own saved run-throughs of a lesson, newest first. Requires a
 * signed-in session; the Worker only ever returns the verified caller's rows.
 * @param {string} lessonId
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<Array<{id, lessonId, answers, completedAt}>>}
 */
export async function fetchMyLessonResponses(lessonId, accessToken) {
  if (!hasApi()) throw new Error("The lesson hub is not configured.");
  if (!lessonId) throw new Error("Missing lesson id.");
  if (!accessToken) throw new Error("Please sign in to see your answers.");

  let res;
  try {
    res = await fetch(endpoint(lessonId), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.responses) ? data.responses : [];
}

/**
 * Save a completed run-through to the signed-in user's account. Called once, at
 * the end of interactive mode — answers are never sent while they're being typed.
 * @param {string} lessonId
 * @param {Array<object>} answers  From collectResponses() in interactive.js.
 * @param {string} accessToken     Supabase session JWT.
 * @returns {Promise<{id, lessonId, answers, completedAt}>}
 */
export async function saveLessonResponses(lessonId, answers, accessToken) {
  if (!hasApi()) throw new Error("The lesson hub is not configured.");
  if (!lessonId) throw new Error("Missing lesson id.");
  if (!accessToken) throw new Error("Please sign in to save your answers.");

  // Fail here rather than after a round trip. The Worker re-checks the same
  // rules — this is a courtesy, not the enforcement.
  const problem = validateResponses(answers);
  if (problem) throw new Error(problem);

  let res;
  try {
    res = await fetch(endpoint(lessonId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ answers }),
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return data.response || {};
}

/**
 * Permanently delete one of your saved run-throughs. The Worker filters on the
 * verified user's id as well as the row id, so this can only ever reach your own.
 * @param {string} lessonId
 * @param {string} responseId
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<void>}
 */
export async function deleteLessonResponse(lessonId, responseId, accessToken) {
  if (!hasApi()) throw new Error("The lesson hub is not configured.");
  if (!lessonId || !responseId) throw new Error("Missing answer id.");
  if (!accessToken) throw new Error("Please sign in to delete your answers.");

  let res;
  try {
    res = await fetch(
      `${endpoint(lessonId)}/${encodeURIComponent(responseId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);
}
