// Thin client over the Spelling Creator Worker's `/lessons` endpoints (the same
// contract the web app uses — see apps/web/src/lib/lessons.js) plus a Supabase
// `whoami` used to confirm the session and read the publisher's display name.
//
// Every write reuses the Worker's existing validation, ban checks, and author
// attribution: we never set the author — the Worker derives it from the verified
// token. On a 401 we transparently refresh the token once and retry, so a
// long-lived server survives the access token expiring between calls.

import { sha256Hex, extFromMime } from "./images.js";

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {ReturnType<import('./auth.js').createAuth>} auth
 */
export function createApi(config, auth) {
  const lessonsUrl = (path = "") => `${config.apiUrl}/lessons${path}`;

  // Fetch a Worker endpoint with a Bearer token, refreshing + retrying once if
  // the token is rejected. `needsAuth: false` is for the public reads.
  async function call(url, { method = "GET", body, needsAuth = true } = {}) {
    const send = async (token) => {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (token) headers.Authorization = `Bearer ${token}`;
      return fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };

    let token = needsAuth ? await auth.getAccessToken() : "";
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

    if (!res.ok) {
      // The Worker returns a short plain-text reason for 4xx/5xx; surface it.
      const detail = await res.text().catch(() => "");
      throw new Error(detail || `Request failed (${res.status}).`);
    }
    // DELETE returns a tiny JSON; everything else returns JSON too.
    return res.json().catch(() => ({}));
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

    /** One lesson including its full `doc`. */
    async getLesson(id) {
      const data = await call(lessonsUrl(`/${encodeURIComponent(id)}`), {
        needsAuth: false,
      });
      if (!data.lesson) throw new Error("Lesson not found.");
      return data.lesson;
    },

    /** Create a lesson. `doc` is the canonical editor document. */
    async createLesson({ title, doc, published }) {
      const data = await call(lessonsUrl(), {
        method: "POST",
        body: { title, doc, published },
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
      const url = `${config.apiUrl}/images/${hash}`;
      const send = (token) =>
        fetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": mime || "application/octet-stream",
            Authorization: `Bearer ${token}`,
          },
          body: bytes,
        });

      let token = await auth.getAccessToken();
      let res;
      try {
        res = await send(token);
      } catch {
        throw new Error(`Could not reach the lesson hub at ${config.apiUrl}.`);
      }
      if (res.status === 401) {
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
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Image upload failed (${res.status}).`);
      }
      return {
        hash,
        mime: mime || "application/octet-stream",
        ext: extFromMime(mime),
      };
    },
  };
}
