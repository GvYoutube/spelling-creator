// Shared Wikimedia Commons plumbing.
//
// The web app and the MCP server both search Commons and download an image from
// it, but they are not interchangeable: the browser client returns the hit shape
// the image dialog renders and supports paging through results, while the MCP
// server returns the shape its tool contract documents and resolves an image
// from a bare "File:…" ref. Their user-facing error strings differ too.
//
// So the adapters stay per-app and only the parts that are genuinely the same
// live here: the endpoint, the query/unwrap round-trip, and the attribution
// metadata handling that Commons' licensing requires.
//
// Nothing in this module may touch the DOM — the MCP server imports it, and that
// runs in Node and inside the Worker. The browser-only refinement (DOMParser for
// HTML stripping) is injected by the web app via `strip`.

export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

/**
 * Flatten Commons' HTML metadata (e.g. an `<a>`-wrapped Artist) to collapsed
 * plain text. Regex-only, so it is safe in every runtime; these fields are small
 * and link-only, never scripts. The web app passes a DOMParser-based version.
 * @param {unknown} html
 * @returns {string}
 */
export function stripCommonsHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the attribution caption Commons' licensing norms expect: author (when
 * known) + licence short name + the source. Authors and licences vary widely, so
 * this degrades gracefully when either is missing.
 * @param {string} author
 * @param {string} license
 * @returns {string}
 */
export function buildCaption(author, license) {
  const credit = [];
  if (author) credit.push(`by ${author}`);
  if (license) credit.push(license);
  const tail = credit.length ? ` (${credit.join(", ")})` : "";
  return `Image${tail} via Wikimedia Commons`;
}

/**
 * Pull author/licence out of an imageinfo `extmetadata` blob and build the
 * caption from them.
 * @param {object} [meta]  imageinfo.extmetadata
 * @param {(html: unknown) => string} [strip]  HTML-to-text (override in browsers)
 * @returns {{author: string, license: string, caption: string}}
 */
export function extmetaCaption(meta = {}, strip = stripCommonsHtml) {
  const author = strip(meta.Artist && meta.Artist.value);
  const license = strip(meta.LicenseShortName && meta.LicenseShortName.value);
  return { author, license, caption: buildCaption(author, license) };
}

/**
 * "File:Red_panda_(cropped).jpg" -> "Red_panda_(cropped)". Used as the human
 * label for a hit.
 * @param {string} [title]
 * @returns {string}
 */
export function cleanFileTitle(title) {
  return (title || "").replace(/^File:/i, "").replace(/\.[a-z0-9]+$/i, "");
}

/**
 * Whether an imageinfo entry is something we can actually embed. The File
 * namespace also holds audio, video and PDFs, and a page with no thumbnail can't
 * be previewed.
 * @param {object} [info]  imageinfo[0]
 * @returns {boolean}
 */
export function isUsableImage(info) {
  if (!info || !info.thumburl) return false;
  return (info.mime || "").startsWith("image/");
}

/**
 * Restore search ranking. `generator=search` results come back keyed by pageid
 * and therefore unordered; `index` carries the rank.
 * @param {object[]} pages
 * @returns {object[]}  a sorted copy
 */
export function rankPages(pages) {
  return [...pages].sort((a, b) => (a.index || 0) - (b.index || 0));
}

/**
 * Call the Commons action API and unwrap `query.pages` to an array.
 *
 * `origin=*` makes the API answer anonymously, which is what lets the browser
 * call it cross-origin without a proxy and lets the server call it without a
 * key.
 *
 * @param {Record<string, string>} params  action-API parameters
 * @param {object} [opts]
 * @param {string} [opts.userAgent]  sent by non-browser callers — Wikimedia's
 *   User-Agent policy throttles or 403s a generic/missing UA, which Node's fetch
 *   default ("node") trips, especially from datacenter egress. Browsers set
 *   their own and forbid overriding it.
 * @param {(status: number) => string} [opts.httpErrorMessage]  wording for a
 *   non-2xx response, so each caller keeps its own phrasing.
 * @returns {Promise<object[]>}
 */
export async function commonsQuery(params, opts = {}) {
  const {
    userAgent,
    httpErrorMessage = (status) =>
      `Wikimedia Commons request failed (${status}).`,
  } = opts;

  const url = `${COMMONS_API}?${new URLSearchParams({
    format: "json",
    origin: "*",
    ...params,
  }).toString()}`;

  const headers = { Accept: "application/json" };
  if (userAgent) headers["User-Agent"] = userAgent;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new Error("Could not reach Wikimedia Commons.", { cause: e });
  }
  if (!res.ok) throw new Error(httpErrorMessage(res.status));

  const data = await res.json().catch(() => ({}));
  return data && data.query && data.query.pages
    ? Object.values(data.query.pages)
    : [];
}
