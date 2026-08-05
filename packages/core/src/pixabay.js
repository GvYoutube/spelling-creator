// Talks to the apps/api Worker for Pixabay image search.
//
// Searching and downloading happen on the Worker rather than in the browser for
// three reasons: the Pixabay API key stays secret, the Worker can enforce
// Pixabay's 100 requests/minute limit centrally, and Pixabay's image CDN sends
// no CORS headers — so the browser can't read an image's bytes to embed it in
// the DOCX/PDF export. The Worker fetches the bytes and returns a data URL we
// can drop straight into an image block.
//
// As with the AI features, every request carries a fresh Turnstile token that
// the Worker verifies server-side before doing any work.
import { apiUrl, hasApi } from "./config.js";

/**
 * Search Pixabay for images matching `query`.
 * @param {string} query  Free-text search terms.
 * @param {string} token  Turnstile token from the widget's callback.
 * @param {object} [opts]
 * @param {number} [opts.page]     1-based page number (default 1).
 * @param {number} [opts.perPage]  Results per page (default 20).
 * @returns {Promise<{hits: object[], total: number, totalHits: number}>}
 *   Normalised hits: { id, previewURL, webformatURL, webformatWidth,
 *   webformatHeight, tags, user, pageURL }.
 */
export async function searchPixabayImages(query, token, opts = {}) {
  if (!hasApi()) {
    throw new Error("The API is not configured.");
  }
  if (!token) {
    throw new Error("Please complete the verification challenge first.");
  }
  const q = (query || "").trim();
  if (!q) {
    throw new Error("Type something to search for first.");
  }

  let res;
  try {
    res = await fetch(apiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "imageSearch",
        query: q,
        token,
        page: opts.page || 1,
        perPage: opts.perPage || 20,
      }),
    });
  } catch (e) {
    throw new Error("Could not reach the image search service.", { cause: e });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Search failed (${res.status}).`);
  }

  const data = await res.json().catch(() => ({}));
  return {
    hits: Array.isArray(data.hits) ? data.hits : [],
    total: data.total || 0,
    totalHits: data.totalHits || 0,
  };
}

/**
 * Download a Pixabay image (by its webformat URL) through the Worker and get it
 * back as a data URL, ready to embed in an image block.
 * @param {string} url    The hit's webformatURL.
 * @param {string} token  A fresh Turnstile token.
 * @returns {Promise<string>} A `data:` URL for the image bytes.
 */
export async function fetchPixabayImage(url, token) {
  if (!hasApi()) {
    throw new Error("The API is not configured.");
  }
  if (!token) {
    throw new Error("Please complete the verification challenge first.");
  }

  let res;
  try {
    res = await fetch(apiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "imageFetch", url, token }),
    });
  } catch (e) {
    throw new Error("Could not download the selected image.", { cause: e });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Download failed (${res.status}).`);
  }

  const data = await res.json().catch(() => ({}));
  if (!data.dataUrl) {
    throw new Error("The image could not be downloaded.");
  }
  return data.dataUrl;
}
