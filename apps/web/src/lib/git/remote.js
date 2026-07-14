// Talking to the lesson's remote — the Worker routes that store a lesson's
// packed repository in R2 (see apps/api/src/routes/git.js).
//
//   GET {API}/git/:lessonId/refs   public  -> { head, refs } (404 when never pushed)
//   GET {API}/git/:lessonId/pack   public  -> the packfile bytes
//   PUT {API}/git/:lessonId/pack   Bearer  -> store them (author only)
//
// This is deliberately not git's smart-HTTP protocol: we control both ends, so a
// whole-history packfile plus a refs pointer is all that's needed to clone, and
// it reuses the same R2-through-the-Worker path the lesson images already take.

const API_URL = import.meta.env.VITE_API_URL;

/** Whether the lesson hub (and so the shared history) is reachable at all. */
export const gitRemoteEnabled = Boolean(API_URL);

function endpoint(lessonId, path) {
  const base = API_URL.replace(/\/$/, "");
  return `${base}/git/${encodeURIComponent(lessonId)}${path}`;
}

/**
 * The tip commit of a lesson's published history.
 * @returns {Promise<{ head: string } | null>} null when the lesson has no repo
 *          on the server (it predates this feature, or was never pushed).
 */
export async function fetchRefs(lessonId) {
  if (!API_URL || !lessonId) return null;

  let res;
  try {
    res = await fetch(endpoint(lessonId, "/refs"), { method: "GET" });
  } catch {
    return null; // offline: history still works locally
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  return data && data.head ? data : null;
}

/**
 * Download a lesson's packed history.
 *
 * The head comes back in the pack's own X-Git-Head header rather than from a
 * separate /refs call: the author replaces the pack in place on every save, so
 * pairing bytes fetched now with a ref fetched a moment ago could name a commit
 * the downloaded pack doesn't contain. Reading both from one response makes that
 * impossible.
 *
 * @returns {Promise<{ packfile: Uint8Array, head: string } | null>} null when the
 *          lesson has no published history.
 */
export async function fetchPack(lessonId) {
  if (!API_URL || !lessonId) return null;

  let res;
  try {
    res = await fetch(endpoint(lessonId, "/pack"), { method: "GET" });
  } catch {
    throw new Error("Could not reach the lesson history.");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Could not download the lesson history.");

  const head = res.headers.get("X-Git-Head");
  if (!head) return null; // a pack with no tip is unusable

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) return null;
  return { packfile: bytes, head };
}

/**
 * Upload the lesson's history. The Worker verifies the caller is the lesson's
 * author before storing it.
 *
 * Failure here is deliberately non-fatal to the caller: the lesson itself is
 * saved through /lessons, and the history is an enhancement on top. A push that
 * fails leaves the local history intact and the next push will carry it.
 */
export async function pushPack(lessonId, { packfile, head }, accessToken) {
  if (!API_URL) throw new Error("The lesson hub is not configured.");
  if (!lessonId) throw new Error("Missing lesson id.");
  if (!accessToken) throw new Error("Please sign in before saving.");

  let res;
  try {
    res = await fetch(endpoint(lessonId, "/pack"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/x-git-packfile",
        "X-Git-Head": head,
        Authorization: `Bearer ${accessToken}`,
      },
      body: packfile,
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Could not save the history (${res.status}).`);
  }
}
