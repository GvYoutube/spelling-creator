// Search Wikimedia Commons for freely-licensed images, and download a chosen one
// for embedding — the MCP server's side of the Commons integration.
//
// Commons is the only image source available here: its MediaWiki action API and
// image CDN both answer anonymous requests (with `origin=*`), so no API key and
// no Turnstile token are required. Pixabay is deliberately NOT supported over
// MCP — it is proxied through the Worker behind a Turnstile challenge the server
// can't satisfy.
//
// Every Commons image carries a licence and most require attribution, so each
// hit (and the resolved download) comes with a ready-made attribution string the
// tools surface as the image caption.
//
// The Commons round-trip and the attribution handling are shared with the web
// app — see @spelling-creator/core/wikimedia. What differs, and so stays here:
// the `ref`-based hit shape this server's tool contract documents, and the
// User-Agent the policy below requires.

import {
  cleanFileTitle,
  commonsQuery,
  extmetaCaption,
  isUsableImage,
  rankPages,
} from "@spelling-creator/core/wikimedia";

// Wikimedia's User-Agent policy (https://meta.wikimedia.org/wiki/User-Agent_policy)
// throttles or 403s requests with a generic/missing UA — Node's fetch defaults to
// just "node", which trips this, especially from shared/datacenter egress (e.g.
// the Cloudflare Worker this server also runs on for remote MCP connections).
const USER_AGENT =
  "SpellingCreatorMCP/0.1.3 (https://spellingcreator.org; MCP server for the Spelling Creator hub)";

/**
 * Search the Commons File namespace for images matching `query`. Returns
 * normalised hits with a `ref` (the "File:…" title) to hand to resolveWikimediaImage.
 * @param {string} query
 * @param {{ perPage?: number }} [opts]
 */
export async function searchWikimediaImages(query, opts = {}) {
  const q = (query || "").trim();
  if (!q) throw new Error("Provide something to search for.");
  const perPage = Math.max(3, Math.min(Number(opts.perPage) || 12, 30));

  const pages = await commonsQuery(
    {
      action: "query",
      generator: "search",
      gsrsearch: q,
      gsrnamespace: "6", // File:
      gsrlimit: String(perPage),
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: "320", // thumbnail for the preview URL
      iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl",
      iiextmetadatalanguage: "en",
    },
    { userAgent: USER_AGENT },
  );

  const hits = [];
  for (const p of rankPages(pages)) {
    const info = p.imageinfo && p.imageinfo[0];
    // The File namespace also holds audio/video/PDF; keep only images.
    if (!isUsableImage(info)) continue;
    const { author, license, caption } = extmetaCaption(info.extmetadata);
    hits.push({
      ref: p.title, // full "File:…" title — the handle for resolveWikimediaImage
      description: cleanFileTitle(p.title),
      caption,
      author,
      license,
      width: info.width,
      height: info.height,
      mime: info.mime,
      previewURL: info.thumburl,
      source: info.descriptionurl || "",
    });
  }
  return hits;
}

/**
 * Download a Commons image for embedding by its "File:…" title, plus the
 * attribution caption. Asks for a thumbnail capped at ~1600px (crisp enough for a
 * lesson, comfortably under the 8 MB upload cap) rather than the full original.
 * @param {string} ref  A "File:…" title from searchWikimediaImages (hit.ref).
 * @returns {Promise<{ bytes: Uint8Array, mime: string, width: number, height: number, caption: string, source: string }>}
 */
export async function resolveWikimediaImage(ref) {
  const title = (ref || "").trim();
  if (!title)
    throw new Error(
      "Provide the image `ref` (the File: title from search_images).",
    );

  const pages = await commonsQuery(
    {
      action: "query",
      titles: title,
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: "1600",
      iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl",
      iiextmetadatalanguage: "en",
    },
    { userAgent: USER_AGENT },
  );
  const info = pages[0] && pages[0].imageinfo && pages[0].imageinfo[0];
  if (!info) {
    throw new Error(
      `No Wikimedia Commons image found for "${title}". Use a "ref" value returned by search_images.`,
    );
  }
  // thumburl is the scaled version; fall back to the original if scaling failed.
  const src = info.thumburl || info.url;
  if (!src) throw new Error("That image could not be downloaded.");

  let imgRes;
  try {
    imgRes = await fetch(src, { headers: { "User-Agent": USER_AGENT } });
  } catch (e) {
    throw new Error("Could not download the selected image.", { cause: e });
  }
  if (!imgRes.ok) throw new Error("Could not download the selected image.");

  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  const { caption } = extmetaCaption(info.extmetadata);
  return {
    bytes,
    mime: imgRes.headers.get("Content-Type") || info.mime || "image/jpeg",
    width: info.thumbwidth || info.width,
    height: info.thumbheight || info.height,
    caption,
    source: info.descriptionurl || "",
  };
}
