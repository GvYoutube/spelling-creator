// Notification API — talks to the same `apps/api` Worker as the rest
// of the hub (see lessons.js / comments.js). The browser never touches the
// database directly; it only calls these Worker endpoints. Every route needs a
// signed-in Supabase session: the access token is passed in and sent as a Bearer
// credential, which the Worker verifies (and scopes results to that user).
//
// Worker endpoints this expects:
//   GET  {API_URL}/notifications            -> { notifications: Notification[] }
//   POST {API_URL}/notifications/read       -> { ok: true }        (body { id? })
//   POST {API_URL}/notifications/send-link  -> { notification }    (body { email, link, message? })
//
// Notification: { id, type, title, body, link, read, createdAt }

const API_URL = import.meta.env.VITE_API_URL;

// Whether a backend is configured at all (mirrors lessonHubEnabled).
export const notificationsEnabled = Boolean(API_URL);

function endpoint(path = "") {
  // Tolerate a trailing slash on VITE_API_URL.
  return `${API_URL.replace(/\/$/, "")}/notifications${path}`;
}

async function readError(res) {
  // The Worker returns a plain-text reason for 4xx/5xx; surface it directly.
  const detail = await res.text().catch(() => "");
  return new Error(detail || `Request failed (${res.status}).`);
}

/**
 * List the signed-in user's notifications, newest first.
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<Array<{id, type, title, body, link, read, createdAt}>>}
 */
export async function fetchNotifications(accessToken) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!accessToken) return [];

  let res;
  try {
    res = await fetch(endpoint(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.notifications) ? data.notifications : [];
}

/**
 * Mark a single notification read (pass its id) or, with no id, all of them.
 * @param {string} accessToken  Supabase session JWT.
 * @param {string} [id]         A specific notification id, or omit for all.
 */
export async function markNotificationsRead(accessToken, id) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!accessToken) throw new Error("Please sign in first.");

  let res;
  try {
    res = await fetch(endpoint("/read"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(id ? { id } : {}),
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);
  return true;
}

/**
 * Send a link to the user with the given email; it pops up in their
 * notifications the next time they load them.
 * @param {object} params
 * @param {string} params.email    Recipient's email address.
 * @param {string} params.link     The URL to send.
 * @param {string} [params.message]  An optional note.
 * @param {string} accessToken     Supabase session JWT (sender).
 * @returns {Promise<{id, type, title, body, link, read, createdAt}>}
 */
export async function sendLink({ email, link, message }, accessToken) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!accessToken) throw new Error("Please sign in before sending a link.");

  let res;
  try {
    res = await fetch(endpoint("/send-link"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ email, link, message }),
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);

  const data = await res.json().catch(() => ({}));
  return data.notification || {};
}
