// Searches Wikimedia Commons for freely-licensed images, entirely in the browser.
//
// Unlike the Pixabay source (web/src/lib/pixabay.js), this needs no API key and
// no Worker proxy: the MediaWiki action API answers anonymous cross-origin
// requests when called with `origin=*`, and Commons' image CDN
// (upload.wikimedia.org) serves images with `Access-Control-Allow-Origin: *`.
// So both the search and the per-image byte download happen client-side, and no
// Turnstile token is required.
//
// Every Commons image carries a licence, and most require attribution, so each
// hit comes with a ready-made attribution string (author + licence + "via
// Wikimedia Commons") that the dialog pre-fills as the image caption.
//
// The Commons round-trip and the attribution handling are shared with the MCP
// server — see ../wikimedia.js. Only the pieces that differ
// live here: paging, the hit shape the dialog renders, and the wording of the
// errors it surfaces.

import {
  cleanFileTitle,
  commonsQuery,
  extmetaCaption,
  isUsableImage,
  rankPages,
} from "../wikimedia.js";

// Strip HTML to plain text using DOMParser, which (unlike assigning innerHTML)
// never executes scripts or fetches sub-resources. Commons' extmetadata fields
// like Artist arrive as HTML (often an <a> link), so we flatten them to text and
// collapse whitespace. Falls back to the shared regex strip if DOMParser is
// unavailable.
function stripHtml(html) {
  if (!html) return "";
  try {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  } catch {
    return String(html)
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
}

// Map one generator=search result page (+ its imageinfo) to a normalised hit
// with the same shape the dialog uses for Pixabay, plus the attribution fields.
function normaliseHit(page, info) {
  const meta = info.extmetadata || {};
  const { author, license, caption } = extmetaCaption(meta, stripHtml);
  return {
    id: page.pageid,
    title: page.title, // full "File:…" title — used by fetchWikimediaImage
    previewURL: info.thumburl,
    // Original dimensions; the real embed dimensions come back from the fetch step.
    width: info.width,
    height: info.height,
    mime: info.mime,
    descriptionURL: info.descriptionurl || "",
    licenseURL: (meta.LicenseUrl && meta.LicenseUrl.value) || "",
    author,
    license,
    tags: cleanFileTitle(page.title),
    caption,
  };
}

/**
 * Search Wikimedia Commons' File namespace for images matching `query`.
 *
 * Uses generator=search (full-text search over file pages) + prop=imageinfo to
 * get, in one request, each match's thumbnail URL, dimensions, MIME type, and
 * the licence/author metadata needed for attribution.
 *
 * @param {string} query  Free-text search terms.
 * @param {object} [opts]
 * @param {number} [opts.page]     1-based page number (default 1).
 * @param {number} [opts.perPage]  Results per page (default 20, max 50).
 * @returns {Promise<{hits: object[], total: number, totalHits: number}>}
 *   Normalised hits: { id, title, previewURL, width, height, mime,
 *   descriptionURL, licenseURL, author, license, tags, caption }.
 */
export async function searchWikimediaImages(query, opts = {}) {
  const q = (query || "").trim();
  if (!q) {
    throw new Error("Type something to search for first.");
  }

  const perPage = Math.max(3, Math.min(Number(opts.perPage) || 20, 50));
  const page = Math.max(1, Number(opts.page) || 1);

  const pages = await commonsQuery(
    {
      action: "query",
      generator: "search",
      gsrsearch: q,
      gsrnamespace: "6", // File: namespace
      gsrlimit: String(perPage),
      gsroffset: String((page - 1) * perPage),
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: "320", // grid thumbnail size
      iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl",
      iiextmetadatalanguage: "en",
    },
    { httpErrorMessage: (status) => `Search failed (${status}).` },
  );

  const hits = [];
  for (const p of rankPages(pages)) {
    const info = p.imageinfo && p.imageinfo[0];
    // Skip non-images (Commons also holds audio/video/PDF in the File namespace).
    if (!isUsableImage(info)) continue;
    hits.push(normaliseHit(p, info));
  }
  return { hits, total: hits.length, totalHits: hits.length };
}

/**
 * Download a Commons image for embedding and return its raw bytes.
 *
 * Rather than the (possibly huge, multi-megabyte) original, this asks the API
 * for a scaled thumbnail capped at ~1600px — crisp enough for a lesson, small
 * enough to stay under the 8 MB upload cap — then fetches those bytes directly
 * from upload.wikimedia.org (which sends CORS headers, so the browser can read
 * them). The bytes are returned for storeImageBytes to hash and store.
 *
 * @param {object} hit  A hit from searchWikimediaImages (needs `title`).
 * @returns {Promise<{bytes: Uint8Array, mime: string, width: number, height: number}>}
 */
export async function fetchWikimediaImage(hit) {
  const title = hit && hit.title;
  if (!title) {
    throw new Error("That image can no longer be loaded.");
  }

  const embedWidth = Math.min(hit.width || 1280, 1600);
  const pages = await commonsQuery(
    {
      action: "query",
      titles: title,
      prop: "imageinfo",
      iiprop: "url|size|mime",
      iiurlwidth: String(embedWidth),
    },
    { httpErrorMessage: (status) => `Download failed (${status}).` },
  );

  const info = pages[0] && pages[0].imageinfo && pages[0].imageinfo[0];
  // thumburl is the scaled version; fall back to the original if scaling failed.
  const src = (info && (info.thumburl || info.url)) || "";
  if (!src) {
    throw new Error("The image could not be downloaded.");
  }

  let imgRes;
  try {
    imgRes = await fetch(src);
  } catch (e) {
    throw new Error("Could not download the selected image.", { cause: e });
  }
  if (!imgRes.ok) {
    throw new Error("Could not download the selected image.");
  }

  const blob = await imgRes.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    bytes,
    mime: blob.type || info.mime || "image/jpeg",
    width: info.thumbwidth || info.width || hit.width,
    height: info.thumbheight || info.height || hit.height,
  };
}
