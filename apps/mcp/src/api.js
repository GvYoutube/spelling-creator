// Thin client over the Spelling Creator Worker's `/lessons` endpoints (the same
// contract the web app uses — see apps/web/src/lib/lessons.js) plus a Supabase
// `whoami` used to confirm the session and read the publisher's display name.
//
// Every write reuses the Worker's existing validation, ban checks, and author
// attribution: we never set the author — the Worker derives it from the verified
// token. On a 401 we transparently refresh the token once and retry, so a
// long-lived server survives the access token expiring between calls.

import {
  DEFAULT_BRANCH,
  parseRefMap,
  serializeRefMap,
} from "@spelling-creator/core/git/refs";
import { sha256Hex, extFromMime } from "./images.js";

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {ReturnType<import('./auth.js').createAuth>} auth
 */
export function createApi(config, auth) {
  const lessonsUrl = (path = "") => `${config.apiUrl}/lessons${path}`;
  const gitUrl = (lessonId, path) =>
    `${config.apiUrl}/git/${encodeURIComponent(lessonId)}${path}`;
  const pullsUrl = (lessonId, path = "") =>
    `${lessonsUrl(`/${encodeURIComponent(lessonId)}`)}/pulls${path}`;

  /**
   * One request to the Worker with a Bearer token, refreshed and retried once if
   * the token is rejected — so a long-lived server survives its access token
   * expiring between calls. Returns the raw Response; the callers below decide
   * what a non-ok status means, because for some of them a 404 is an answer
   * ("this lesson has no history") rather than a failure.
   *
   * `body` is passed through untouched, so this carries JSON and packfile bytes
   * alike; JSON callers go through `call` below, which serialises for them.
   */
  async function request(
    url,
    { method = "GET", headers, body, needsAuth = true } = {},
  ) {
    const send = async (token) => {
      const sent = { ...headers };
      if (token) sent.Authorization = `Bearer ${token}`;
      return fetch(url, { method, headers: sent, body });
    };

    const token = needsAuth ? await auth.getAccessToken() : "";
    let res;
    try {
      res = await send(token);
    } catch {
      throw new Error(`Could not reach the lesson hub at ${config.apiUrl}.`);
    }

    if (res.status === 401 && needsAuth) {
      const refreshed = await auth.forceRefresh();
      if (refreshed) {
        try {
          res = await send(refreshed);
        } catch {
          throw new Error(
            `Could not reach the lesson hub at ${config.apiUrl}.`,
          );
        }
      }
    }
    return res;
  }

  /** The Worker returns a short plain-text reason for 4xx/5xx; surface it. */
  async function readError(res, fallback) {
    const detail = await res.text().catch(() => "");
    return new Error(detail || fallback || `Request failed (${res.status}).`);
  }

  // A JSON call: serialise the body, throw on a bad status, return the parsed
  // response. `needsAuth: false` is for the public reads.
  async function call(url, { method = "GET", body, needsAuth = true } = {}) {
    const res = await request(url, {
      method,
      needsAuth,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await readError(res);
    // DELETE returns a tiny JSON; everything else returns JSON too.
    return res.json().catch(() => ({}));
  }

  /**
   * Upload a packfile — a lesson's history, or a proposal's snapshot of one. The
   * tip travels in X-Git-Head so the bytes and the ref they belong to can never
   * be paired from two different moments (see core/git/remote.js).
   */
  async function putPack(
    url,
    { packfile, head, parent, refs, expected },
    badStatusMessage,
  ) {
    const headers = {
      "Content-Type": "application/x-git-packfile",
      "X-Git-Head": head,
    };
    // The compare-and-swap: the head we believe the lesson points at. Omitted
    // when it has no history yet.
    if (parent) headers["X-Git-Parent"] = parent;
    // And the same claim for every branch the pack carries. A lesson can hold a
    // branch per variation its author is trying out, and packRepo sends all of
    // them — so the push has to name them all, or the hub would be left
    // advertising tips whose objects the stored pack no longer contains.
    if (refs) headers["X-Git-Refs"] = serializeRefMap(refs);
    if (expected) headers["X-Git-Expected"] = serializeRefMap(expected);

    const res = await request(url, { method: "PUT", headers, body: packfile });
    if (!res.ok) throw await readError(res, badStatusMessage);
    return res.json().catch(() => ({}));
  }

  /**
   * Download a packfile, with its tip from the same response. Returns null when
   * there is no history stored (404) rather than throwing: for a lesson that
   * predates version history, "no repo" is a normal answer a fork has to handle.
   */
  async function getPack(url) {
    const res = await request(url);
    if (res.status === 404) return null;
    if (!res.ok) throw await readError(res, "Could not download the history.");

    const head = res.headers.get("X-Git-Head");
    if (!head) return null; // a pack with no tip is unusable
    const packfile = new Uint8Array(await res.arrayBuffer());
    if (packfile.byteLength === 0) return null;
    // The branch map comes off the same response as the bytes, so the two can
    // never be paired from different moments. A lesson stored before variations
    // existed sends none, which reads as the one branch it has.
    const refs = parseRefMap(res.headers.get("X-Git-Refs")) || {
      [DEFAULT_BRANCH]: head,
    };
    return { packfile, head, refs };
  }

  return {
    /** Verify the session and return the Supabase user (id, email, display name). */
    async whoami() {
      const token = await auth.getAccessToken();
      const fetchUser = (tok) =>
        fetch(`${config.supabaseUrl}/auth/v1/user`, {
          headers: {
            Authorization: `Bearer ${tok}`,
            apikey: config.supabaseAnonKey,
          },
        });
      let res = await fetchUser(token);
      if (res.status === 401) {
        const refreshed = await auth.forceRefresh();
        if (refreshed) res = await fetchUser(refreshed);
      }
      if (!res.ok) {
        throw new Error(
          "Your session is not valid. Sign in again with the `login` helper.",
        );
      }
      const user = await res.json();
      return {
        id: user.id,
        email: user.email,
        displayName: user.user_metadata?.display_name || "",
      };
    },

    /** Public listing of published lessons, newest first. */
    async listHubLessons() {
      const data = await call(lessonsUrl(), { needsAuth: false });
      return Array.isArray(data.lessons) ? data.lessons : [];
    },

    /** The signed-in user's own lessons (drafts and published). */
    async listMyLessons() {
      const data = await call(lessonsUrl("/mine"));
      return Array.isArray(data.lessons) ? data.lessons : [];
    },

    /**
     * One lesson including its full `doc`. Sends the caller's token even though
     * published reads don't need it — the Worker only recognises an owner (or
     * trusted collaborator/moderator) on a draft or shadowbanned lesson via that
     * same Bearer token, so omitting it made those reads 404 as "not found".
     */
    async getLesson(id) {
      const data = await call(lessonsUrl(`/${encodeURIComponent(id)}`));
      if (!data.lesson) throw new Error("Lesson not found.");
      return data.lesson;
    },

    /**
     * Create a lesson. `doc` is the canonical editor document. `forkedFrom` is
     * the lesson this one was forked from, which the hub records as the fork's
     * pointer home — it's what lets the fork later pull the original's changes
     * in, and what a proposal links back to.
     */
    async createLesson({ title, doc, published, forkedFrom }) {
      const data = await call(lessonsUrl(), {
        method: "POST",
        body: {
          title,
          doc,
          published,
          ...(forkedFrom ? { forkedFrom } : {}),
        },
      });
      return data.lesson || {};
    },

    /** Replace a lesson's title/doc (author only). Optionally flip published. */
    async updateLesson(id, { title, doc, published }) {
      const body = { title, doc };
      if (typeof published === "boolean") body.published = published;
      const data = await call(lessonsUrl(`/${encodeURIComponent(id)}`), {
        method: "PUT",
        body,
      });
      return data.lesson || {};
    },

    /** Permanently delete a lesson (author only). */
    async deleteLesson(id) {
      await call(lessonsUrl(`/${encodeURIComponent(id)}`), {
        method: "DELETE",
      });
      return { ok: true };
    },

    // ---- Version history and proposals -------------------------------------
    //
    // A lesson's history is a git repository, and it travels as a packfile (see
    // packages/core/src/git/). These four are what forking and proposing need:
    // read a lesson's history, write a fork's, and open a proposal carrying it.
    // Unlike the browser's equivalents (core/git/remote.js, core/pulls.js) these
    // always send the caller's token — a fork starts life as a private draft, so
    // its own history is not a public read.

    /**
     * Download a lesson's packed history, or null when it has none (an older
     * lesson from before version history, or one never pushed).
     */
    async fetchLessonPack(lessonId) {
      return getPack(gitUrl(lessonId, "/pack"));
    },

    /**
     * The tip of a lesson's published history, or null when it has none.
     *
     * Only a 404 means "none" — every other bad status is a genuine failure and
     * throws, rather than being flattened into the same answer. A caller that
     * would rather not know (the proposal's informational `base`) can catch it;
     * one that needs the real head must not be told there isn't one.
     */
    async fetchLessonHead(lessonId) {
      const res = await request(gitUrl(lessonId, "/refs"));
      if (res.status === 404) return null;
      if (!res.ok)
        throw await readError(res, "Could not read the lesson history.");
      const data = await res.json().catch(() => null);
      return data?.head || null;
    },

    /**
     * Upload a lesson's history. `parent` is the head we believe it points at —
     * the Worker refuses the push if the lesson has moved on since, which is
     * what stops two writers erasing each other.
     */
    async pushLessonPack(lessonId, { packfile, head, parent, refs, expected }) {
      return putPack(
        gitUrl(lessonId, "/pack"),
        { packfile, head, parent, refs, expected },
        "Could not save the lesson history.",
      );
    },

    /** The proposals open against a lesson, and whether we may review them. */
    async listPulls(lessonId) {
      const data = await call(pullsUrl(lessonId));
      return {
        pulls: Array.isArray(data.pulls) ? data.pulls : [],
        canReview: Boolean(data.canReview),
      };
    },

    /**
     * Open a proposal against a lesson. This creates the request but not its
     * contents — the changes follow as a packfile (uploadPullPack), and until
     * that lands the request is unready and nobody but its author sees it.
     */
    async createPull(lessonId, { title, body, head, base, sourceLessonId }) {
      const data = await call(pullsUrl(lessonId), {
        method: "POST",
        body: {
          title,
          body,
          head,
          ...(base ? { base } : {}),
          ...(sourceLessonId ? { sourceLessonId } : {}),
        },
      });
      if (!data.pull) throw new Error("Could not open the proposal.");
      return data.pull;
    },

    /** Upload a proposal's packfile — the changes themselves. */
    async uploadPullPack(lessonId, pullId, { packfile, head }) {
      const data = await putPack(
        pullsUrl(lessonId, `/${encodeURIComponent(pullId)}/pack`),
        { packfile, head },
        "Could not upload the proposed changes.",
      );
      return data.pull || null;
    },

    /** Withdraw a proposal (used to clean up one whose pack never landed). */
    async closePull(lessonId, pullId) {
      const data = await call(
        pullsUrl(lessonId, `/${encodeURIComponent(pullId)}/close`),
        { method: "POST" },
      );
      return data.pull || null;
    },

    /**
     * Upload raw image bytes to R2 by their content hash and return the image
     * ref to put on an image block ({ hash, mime, ext }). PUT /images/:hash is
     * authenticated and verifies the body hashes to :hash, so the bytes can only
     * land at the key they actually address. Idempotent — re-uploading identical
     * bytes is a harmless no-op. Refreshes + retries once on a 401, like `call`.
     * @param {Uint8Array} bytes
     * @param {string} mime
     */
    async uploadImage(bytes, mime) {
      const hash = await sha256Hex(bytes);
      const res = await request(`${config.apiUrl}/images/${hash}`, {
        method: "PUT",
        headers: { "Content-Type": mime || "application/octet-stream" },
        body: bytes,
      });
      if (!res.ok) {
        throw await readError(res, `Image upload failed (${res.status}).`);
      }
      return {
        hash,
        mime: mime || "application/octet-stream",
        ext: extFromMime(mime),
      };
    },
  };
}
