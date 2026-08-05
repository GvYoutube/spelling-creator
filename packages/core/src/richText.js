// The rich-text policy — the rules about what formatting a comment or bio may
// carry, shared by the two places that enforce them.
//
// Both sanitizers are deliberately NOT here. The Worker sanitizes on write with
// HTMLRewriter (the runtime's native streaming parser) and the browser sanitizes
// again at render time with DOMPurify, because the render path uses
// dangerouslySetInnerHTML and a reader's safety should not depend on every stored
// row having been written by the current version of the Worker. Those are two
// real parsers for two runtimes and neither can run in the other.
//
// What CAN drift between them, and previously did, is everything they agree on:
// which tags survive, which link schemes are real links, what a link is rewritten
// to carry, and how markup flattens to text. Both files used to carry their own
// copy under a different name, each with a comment telling the reader to keep
// them in sync by hand. They are here instead.
//
// The flattening is the one with a visible failure mode: the editor's character
// counter and the Worker's length limit must measure the same thing, or the
// editor shows "498/500" for a comment the server then rejects.

/**
 * The formatting a rendered comment or bio may contain. Deliberately small: the
 * marks and blocks the editor's toolbar can produce, and nothing else. `b`/`i`
 * are included because pasted content often carries them (tiptap normalises its
 * own output to `strong`/`em`).
 *
 * Note what is absent: img, video, audio, iframe, svg. Users may format text but
 * may not embed media. This list failing closed — anything unnamed is dropped —
 * is the primary enforcement; MEDIA_TAGS below is the explicit statement of it.
 */
export const RICH_TEXT_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
];

/**
 * The product rule, stated explicitly: users may format text, but may not upload
 * or embed media. The editor simply has no such buttons, which only stops honest
 * clients — this is what enforces it for everyone else, including media smuggled
 * in as a `data:` URI.
 */
export const MEDIA_TAGS = [
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "track",
  "canvas",
  "svg",
  "math",
];

/**
 * The only schemes a stored link may use. `javascript:` executes; `data:` is an
 * HTML and media smuggling channel (`data:text/html,…`), so both are rejected
 * along with anything else exotic. Relative and protocol-relative hrefs are
 * rejected too — user-generated links point outward, at real destinations.
 */
export const SAFE_LINK_PROTOCOLS = /^(?:https?:|mailto:)/i;

// Characters browsers ignore inside a URL scheme. `java\tscript:alert(1)`
// navigates perfectly well while sailing past a naive prefix check, so strip
// these before testing the scheme. Matching control characters is precisely the
// point here, which is what no-control-regex objects to — hence the exemption.
// eslint-disable-next-line no-control-regex
const URL_IGNORED_CHARS = /[\u0000-\u0020]/g;

/**
 * Whether a link target is safe to store or render.
 * @param {string} href
 * @returns {boolean}
 */
export function isSafeLink(href) {
  const value = typeof href === "string" ? href.trim() : "";
  if (!value) return false;
  return SAFE_LINK_PROTOCOLS.test(value.replace(URL_IGNORED_CHARS, ""));
}

/**
 * What a surviving link is rewritten to carry: user-generated links open away
 * from the app, pass no SEO value to spammers, and cannot reach back through
 * `window.opener`.
 */
export const LINK_TARGET = "_blank";
export const LINK_REL = "nofollow ugc noopener noreferrer";

// Named entities that survive sanitizing and matter once we flatten to text.
const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Flatten rich-text HTML to plain text.
 *
 * Everything downstream of storage wants text, not markup: the profanity filter
 * (which must scan words, not tag names), the length limit (which should bound
 * what a user *wrote*, not how much markup it took), the Atom feed's `<summary>`,
 * notification bodies, meta descriptions, and the editor's own character counter.
 *
 * Safe to run on legacy plain-text values — every comment and bio written before
 * rich text is a bare string, and one with no tags passes through unchanged.
 *
 * @param {string} html
 * @returns {string} Plain text, with block boundaries collapsed to newlines.
 */
export function richTextToPlain(html) {
  const input = typeof html === "string" ? html : "";
  if (!input) return "";

  return (
    input
      // Block boundaries become line breaks so words don't run together.
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|blockquote|pre|h[1-6]|tr)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
        String.fromCodePoint(parseInt(code, 16)),
      )
      .replace(/&[a-z]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ")
      // Collapse runs of spaces (including the non-breaking ones just decoded),
      // then tidy the line breaks the block rules introduced.
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * How many characters the user actually wrote, ignoring the markup they wrote
 * them in. This is what both the editor's counter and the server's limit measure.
 * @param {string} html
 * @returns {number}
 */
export function richTextLength(html) {
  return richTextToPlain(html).length;
}

/**
 * Whether a rich-text value carries no actual words. An "empty" editor still
 * emits markup (`<p></p>`), so a plain `!html` check would happily store a blank
 * comment.
 * @param {string} html
 * @returns {boolean}
 */
export function isRichTextEmpty(html) {
  return richTextToPlain(html) === "";
}

/**
 * Collapse rich text to a single line, for the places that show a bio or comment
 * where markup can't go: a meta/OG description, a one-line list subtitle.
 * @param {string} html
 * @param {number} [max] Truncate beyond this many characters.
 * @returns {string}
 */
export function richTextToLine(html, max = 160) {
  const text = richTextToPlain(html).replace(/\s*\n\s*/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Whether a stored value is rich-text HTML rather than one of the plain strings
 * written before rich text existed.
 *
 * Everything the editor produces is wrapped in a block tag, so it always starts
 * with one; a plain-text comment realistically never does. Legacy values are
 * rendered as preformatted text (so their newlines survive) instead of being
 * parsed as markup, which is both what their authors meant and what they have
 * always looked like.
 * @param {string} value
 * @returns {boolean}
 */
export function isRichTextHtml(value) {
  return typeof value === "string" && /^\s*<[a-z]/i.test(value);
}
