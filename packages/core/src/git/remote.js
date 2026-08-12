// Talking to the lesson's remote — the Worker routes that store a lesson's
// packed repository in R2 (see apps/api/src/routes/git.js).
//
//   GET {API}/git/:lessonId/refs   public  -> { head, refs } (404 when never pushed)
//   GET {API}/git/:lessonId/pack   public  -> the packfile bytes, with its tip and
//                                             branch map in X-Git-Head/X-Git-Refs
//   PUT {API}/git/:lessonId/pack   Bearer  -> store them (the author, or a trusted
//                                             collaborator merging a fork back in)
//
// This is deliberately not git's smart-HTTP protocol: we control both ends, so a
// whole-history packfile plus a refs pointer is all that's needed to clone, and
// it reuses the same R2-through-the-Worker path the lesson images already take.
//
// Because a lesson has more than one possible writer, PUT is a compare-and-swap:
// see pushPack below.
import { apiUrl, hasApi } from "../config.js";
import { DEFAULT_BRANCH, parseRefMap, serializeRefMap } from "./refs.js";

/** Whether the lesson hub (and so the shared history) is reachable at all. */

function endpoint(lessonId, path) {
  const base = apiUrl();
  return `${base}/git/${encodeURIComponent(lessonId)}${path}`;
}

/**
 * The tip commits of a lesson's published history: `head` for the lesson itself,
 * and `refs` naming every branch it holds.
 *
 * @returns {Promise<{ head: string, refs?: object } | null>} null when the lesson
 *          has no repo on the server (it predates this feature, or was never
 *          pushed).
 */
export async function fetchRefs(lessonId) {
  if (!hasApi() || !lessonId) return null;

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
 * The branch map rides in the same response for the same reason, as X-Git-Refs.
 * A lesson stored before it could have more than one branch sends no map, which
 * reads as the one branch it had.
 *
 * @returns {Promise<{ packfile: Uint8Array, head: string, refs: object } | null>}
 *          null when the lesson has no published history.
 */
export async function fetchPack(lessonId) {
  if (!hasApi() || !lessonId) return null;

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

  // A map we can't read is treated as absent rather than fatal: the default
  // branch is in X-Git-Head regardless, so the lesson itself still clones.
  const refs = parseRefMap(res.headers.get("X-Git-Refs")) || {
    [DEFAULT_BRANCH]: head,
  };
  return { packfile: bytes, head, refs };
}

/**
 * Thrown when a push is rejected because the lesson's history moved on since we
 * last synced — someone else (the author, or another trusted collaborator) pushed
 * in the meantime. The caller must merge their changes and try again; see
 * pushHistory() in sync.js, which does exactly that.
 */
export class HistoryMovedError extends Error {
  constructor(message) {
    super(message);
    this.name = "HistoryMovedError";
  }
}

/**
 * Upload the lesson's history. The Worker verifies the caller is the lesson's
 * author, or a trusted collaborator merging a fork back in.
 *
 * `parent` is the head we believe the lesson currently points at — the
 * compare-and-swap. The Worker rejects the push (409) if that isn't the head it
 * holds, which is what stops two writers from overwriting each other's commits.
 * Pass null only when the lesson has no history at all yet.
 *
 * ---- Pushing more than one branch -------------------------------------------
 *
 * A lesson holds a branch per variation, and a push moves as many of them as
 * changed. Three headers describe that, and the Worker applies all of it or none:
 *
 *   X-Git-Refs      the branches to set, `{ "<name>": "<oid>" }`
 *   X-Git-Expected  what we believe the hub currently holds for each name we are
 *                   touching — "" meaning "I believe this one does not exist"
 *   X-Git-Deletes   the branches to remove, comma-separated
 *
 * The compare-and-swap is per branch, and it guards the same thing it always did,
 * one level down: a branch we don't mention is left exactly as it is, so a device
 * that has never heard of somebody's new variation cannot delete it by omission.
 * Pushing only `parent` and `head` — which is what a client written before any of
 * this does — still means "move the lesson, leave everything else alone".
 */
export async function pushPack(
  lessonId,
  { packfile, head, parent, refs, expected, deletes },
  accessToken,
) {
  if (!hasApi()) throw new Error("The lesson hub is not configured.");
  if (!lessonId) throw new Error("Missing lesson id.");
  if (!accessToken) throw new Error("Please sign in before saving.");

  const headers = {
    "Content-Type": "application/x-git-packfile",
    "X-Git-Head": head,
    Authorization: `Bearer ${accessToken}`,
  };
  if (parent) headers["X-Git-Parent"] = parent;
  if (refs) headers["X-Git-Refs"] = serializeRefMap(refs);
  if (expected) headers["X-Git-Expected"] = serializeRefMap(expected);
  if (deletes?.length) headers["X-Git-Deletes"] = deletes.join(",");

  let res;
  try {
    res = await fetch(endpoint(lessonId, "/pack"), {
      method: "PUT",
      headers,
      body: packfile,
    });
  } catch {
    throw new Error("Could not reach the lesson hub.");
  }
  if (res.status === 409) {
    throw new HistoryMovedError(
      (await res.text().catch(() => "")) ||
        "This lesson's history has moved on since you last synced.",
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Could not save the history (${res.status}).`);
  }
}
