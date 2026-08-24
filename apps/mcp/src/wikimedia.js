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
  "SpellingCreatorMCP/0.6.0 (https://spellingcreator.org; MCP server for the Spelling Creator hub)";

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

// Commons scales on request, so we take a thumbnail rather than the original —
// 1600px is more than a lesson page ever shows. Downscaling here is not just a
// bandwidth saving: the hub re-encodes PNG/JPEG uploads to WEBP inside a
// Cloudflare Worker (apps/api/src/imageConvert.js), a WASM decode-and-encode
// whose cost is all pixels, and a full-size scan used to kill that Worker
// outright ("Error 1102: Worker exceeded resource limits" — a size failure no
// retry fixes). Authors used to have to learn that by picking a smaller
// candidate; the server picks one for them instead.
const THUMB_WIDTH = 1600;
// A thumbnail that is still heavy at 1600px (a detailed map, a scan of a page)
// gets one more, smaller pass rather than being pushed at the converter.
const HEAVY_BYTES = 1.5 * 1024 * 1024;
const SMALL_THUMB_WIDTH = 1000;
// The hub's own PUT limit (apps/api/src/lib/images.js MAX_IMAGE_BYTES). Past
// this the upload is refused, so say so here where the fix — a different
// candidate — is still available.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// Image metadata for one File: title, including the URL of a thumbnail scaled to
// `width`. Commons returns the original's URL as `thumburl` when it can't scale
// (some formats, some very large files), which is why callers check the size of
// what they actually got rather than trusting the request.
async function imageInfo(title, width) {
  const pages = await commonsQuery(
    {
      action: "query",
      titles: title,
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: String(width),
      iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl",
      iiextmetadatalanguage: "en",
    },
    { userAgent: USER_AGENT },
  );
  return pages[0] && pages[0].imageinfo && pages[0].imageinfo[0];
}

async function downloadImage(src) {
  let res;
  try {
    res = await fetch(src, { headers: { "User-Agent": USER_AGENT } });
  } catch (e) {
    throw new Error("Could not download the selected image.", { cause: e });
  }
  if (!res.ok) throw new Error("Could not download the selected image.");
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    mime: res.headers.get("Content-Type") || "",
  };
}

/**
 * Download a Commons image for embedding by its "File:…" title, plus the
 * attribution caption. Fetches a downscaled thumbnail rather than the original
 * (see THUMB_WIDTH), so the caller never has to size-shop for a candidate that
 * will survive the upload.
 * @param {string} ref  A "File:…" title from searchWikimediaImages (hit.ref).
 * @returns {Promise<{ bytes: Uint8Array, mime: string, width: number, height: number, caption: string, source: string }>}
 */
export async function resolveWikimediaImage(ref) {
  const title = (ref || "").trim();
  if (!title)
    throw new Error(
      "Provide the image `ref` (the File: title from search_images).",
    );

  let info = await imageInfo(title, THUMB_WIDTH);
  if (!info) {
    throw new Error(
      `No Wikimedia Commons image found for "${title}". Use a "ref" value returned by search_images.`,
    );
  }
  // thumburl is the scaled version; fall back to the original if scaling failed.
  const src = info.thumburl || info.url;
  if (!src) throw new Error("That image could not be downloaded.");

  let download = await downloadImage(src);

  // Still heavy? Come back for a smaller rendering. Keep it only if it actually
  // is smaller — when Commons couldn't scale the file the second request returns
  // the same bytes as the first.
  if (download.bytes.byteLength > HEAVY_BYTES) {
    const smaller = await imageInfo(title, SMALL_THUMB_WIDTH);
    if (smaller?.thumburl) {
      const retry = await downloadImage(smaller.thumburl);
      if (retry.bytes.byteLength < download.bytes.byteLength) {
        info = smaller;
        download = retry;
      }
    }
  }

  if (download.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `"${title}" is ${Math.round(download.bytes.byteLength / (1024 * 1024))} MB even at the smallest ` +
        "rendering Commons will produce, which is over the 8 MB upload limit. This is a property of the file, " +
        "not a transient failure — pick a different candidate from search_images rather than retrying this one.",
    );
  }

  const { caption } = extmetaCaption(info.extmetadata);
  return {
    bytes: download.bytes,
    mime: download.mime || info.mime || "image/jpeg",
    width: info.thumbwidth || info.width,
    height: info.thumbheight || info.height,
    caption,
    source: info.descriptionurl || "",
  };
}
