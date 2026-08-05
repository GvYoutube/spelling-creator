// Moderation API — talks to the same `apps/api` Worker as the rest of
// the hub (see lessons.js / comments.js). Every endpoint here is privileged: the
// Worker re-derives the caller's role from the database on each request, so these
// functions just send the Supabase JWT as a Bearer credential and surface the
// Worker's plain-text reason on failure. The browser's view of "am I a mod/admin"
// (fetchMyRole) is only ever used to decide what UI to show — never to authorise.
//
// Worker endpoints (see handleModeration in apps/api/src/routes/moderation.js).
// Named "/mod", not "/moderation" — the SPA already owns the "/moderation"
// page route, and the Worker sees every request before its static assets do
// (run_worker_first), so an API route at the same path as a page would
// swallow that page's direct loads/reloads instead of ever serving it.
//   GET    /mod/whoami                         -> { role }            (any signed-in)
//   DELETE /mod/comments/:id                                          (mod+)
//   POST   /mod/lessons/:id/shadowban          { shadowbanned }       (mod+)
//   POST   /mod/lessons/:id/delete-request     { reason }             (mod+)
//   GET    /mod/lessons/shadowbanned           -> { lessons }         (mod+)
//   DELETE /mod/lessons/:id                                           (admin)
//   GET    /mod/delete-requests                -> { requests }        (admin)
//   POST   /mod/delete-requests/:id/approve|deny                      (admin)
//   GET    /mod/bans                           -> { names, ips }      (mod+ / admin)
//   POST   /mod/bans/name                      { name }               (mod+)
//   DELETE /mod/bans/name/:nameLower                                  (mod+)
//   POST   /mod/bans/ip                        { ip, reason? }        (admin)
//   DELETE /mod/bans/ip/:ip                                           (admin)
//   GET    /mod/moderators                     -> { moderators }      (admin)
//   POST   /mod/moderators                     { email }              (admin)
//   DELETE /mod/moderators/:userId                                    (admin)
import { apiUrl, hasApi } from "./config.js";

function endpoint(path = "") {
  return `${apiUrl()}/mod${path}`;
}

async function readError(res) {
  const detail = await res.text().catch(() => "");
  const err = new Error(detail || `Request failed (${res.status}).`);
  err.status = res.status;
  return err;
}

// Shared request helper: attaches the Bearer token, parses JSON, surfaces the
// Worker's plain-text reason on a non-2xx.
async function request(path, { method = "GET", accessToken, body } = {}) {
  if (!hasApi()) throw new Error("The lesson hub is not configured.");
  if (!accessToken) throw new Error("Please sign in.");
  let res;
  try {
    res = await fetch(endpoint(path), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) throw await readError(res);
  return res.json().catch(() => ({}));
}

/**
 * The signed-in user's moderation tier: "admin", "moderator", or null. Used only
 * to decide which controls to render — every action is independently authorised
 * server-side. Returns null (not an error) when sign-in isn't configured or the
 * lookup fails, so a hiccup never blocks an ordinary user.
 * @param {string} accessToken Supabase session JWT.
 * @returns {Promise<"admin"|"moderator"|null>}
 */
export async function fetchMyRole(accessToken) {
  if (!hasApi() || !accessToken) return null;
  try {
    const data = await request("/whoami", { accessToken });
    return data.role || null;
  } catch {
    return null;
  }
}

// --- Comments -------------------------------------------------------------

export function deleteCommentAsMod(commentId, accessToken) {
  return request(`/comments/${encodeURIComponent(commentId)}`, {
    method: "DELETE",
    accessToken,
  });
}

// --- Lessons --------------------------------------------------------------

export async function setShadowban(lessonId, shadowbanned, accessToken) {
  const data = await request(
    `/lessons/${encodeURIComponent(lessonId)}/shadowban`,
    {
      method: "POST",
      accessToken,
      body: { shadowbanned },
    },
  );
  return data.lesson || {};
}

export function requestLessonDeletion(lessonId, reason, accessToken) {
  return request(`/lessons/${encodeURIComponent(lessonId)}/delete-request`, {
    method: "POST",
    accessToken,
    body: { reason: reason || "" },
  });
}

export async function listShadowbannedLessons(accessToken) {
  const data = await request("/lessons/shadowbanned", { accessToken });
  return Array.isArray(data.lessons) ? data.lessons : [];
}

export function deleteLessonAsAdmin(lessonId, accessToken) {
  return request(`/lessons/${encodeURIComponent(lessonId)}`, {
    method: "DELETE",
    accessToken,
  });
}

// --- Lesson-deletion requests (admin) ------------------------------------

export async function listDeleteRequests(accessToken) {
  const data = await request("/delete-requests", { accessToken });
  return Array.isArray(data.requests) ? data.requests : [];
}

export function resolveDeleteRequest(requestId, approve, accessToken) {
  return request(
    `/delete-requests/${encodeURIComponent(requestId)}/${approve ? "approve" : "deny"}`,
    {
      method: "POST",
      accessToken,
    },
  );
}

// --- Bans -----------------------------------------------------------------

export async function listBans(accessToken) {
  const data = await request("/bans", { accessToken });
  return {
    names: Array.isArray(data.names) ? data.names : [],
    ips: Array.isArray(data.ips) ? data.ips : [],
  };
}

export function banName(name, accessToken) {
  return request("/bans/name", { method: "POST", accessToken, body: { name } });
}

export function unbanName(nameLower, accessToken) {
  return request(`/bans/name/${encodeURIComponent(nameLower)}`, {
    method: "DELETE",
    accessToken,
  });
}

export function banIp(ip, reason, accessToken) {
  return request("/bans/ip", {
    method: "POST",
    accessToken,
    body: { ip, reason: reason || "" },
  });
}

export function unbanIp(ip, accessToken) {
  return request(`/bans/ip/${encodeURIComponent(ip)}`, {
    method: "DELETE",
    accessToken,
  });
}

// --- Moderators (admin) ---------------------------------------------------

export async function listModerators(accessToken) {
  const data = await request("/moderators", { accessToken });
  return Array.isArray(data.moderators) ? data.moderators : [];
}

export function addModerator(email, accessToken) {
  return request("/moderators", {
    method: "POST",
    accessToken,
    body: { email },
  });
}

export function removeModerator(userId, accessToken) {
  return request(`/moderators/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    accessToken,
  });
}
