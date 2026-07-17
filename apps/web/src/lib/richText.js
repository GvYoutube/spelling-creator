// Rich text on the browser side — the counterpart to apps/api/src/lib/richtext.js.
//
// Comments and bios are rich text: HTML written with tiptap (RichTextInput.jsx)
// and rendered back as HTML (RichText.jsx). Two jobs live here:
//
//   1. `sanitizeRichText` — a second, independent sanitizing pass at render time.
//      The Worker already sanitizes everything it stores, and that is the boundary
//      that actually protects us. This pass exists because the render path uses
//      dangerouslySetInnerHTML, and it should not be the case that the safety of a
//      reader's session depends on every row in the database having been written by
//      the current version of the Worker. Rows predating rich text, rows written by
//      some future path that forgets to sanitize, a bug in the allow-list — all are
//      caught here, at the last moment before the HTML becomes DOM.
//
//   2. `richTextToPlainText` — flatten to text for the places that can't show
//      markup: the length counter, a one-line bio in a list, a meta description.
//
// The flattening deliberately mirrors the Worker's `richTextToPlain` step for step.
// The two must agree on what counts as a character, or the editor would cheerfully
// show "498/500" for a comment the server then rejects as too long. If you change one,
// change the other.

import DOMPurify from "dompurify";

// The formatting a rendered comment or bio may contain. Mirrors KEEP_TAGS in the
// Worker's sanitizer. Note what is absent: img, video, audio, iframe, svg — users may
// format text but may not embed media, and this is the render-side half of enforcing
// that. Everything else DOMPurify drops by virtue of not being on the list.
const ALLOWED_TAGS = [
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

// Only links carry attributes, and only these. No `src`, no `style`, no `on*`.
const ALLOWED_ATTR = ["href", "target", "rel"];

// Anything not http(s) or mailto — `javascript:` (executes) and `data:` (smuggles
// HTML and media) above all — is not a link we will render.
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

// User-generated links open away from the app, carry no SEO value for spammers, and
// can't reach back through window.opener. The Worker sets these too; we re-assert
// them here so a link that reaches us any other way still gets them.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "nofollow ugc noopener noreferrer");
  }
});

/**
 * Sanitize rich-text HTML for rendering. See the note above on why this runs even
 * though the Worker already sanitized on write.
 * @param {string} html
 * @returns {string} HTML safe to inject.
 */
export function sanitizeRichText(html) {
  if (!html) return "";
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    // Redundant given the allow-list, but states the product rule where a future
    // reader will look for it: no embedded media, ever.
    FORBID_TAGS: [
      "img",
      "picture",
      "source",
      "video",
      "audio",
      "iframe",
      "object",
      "embed",
      "svg",
      "canvas",
      "script",
      "style",
    ],
  });
}

// Named entities that matter once we flatten to text. Mirrors the Worker's table.
const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Flatten rich-text HTML to plain text. Mirrors the Worker's `richTextToPlain`, so
 * the character count shown in the editor is the character count the server enforces.
 *
 * Passes legacy plain-text values (every comment and bio written before rich text)
 * through unchanged.
 *
 * @param {string} html
 * @returns {string}
 */
export function richTextToPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|blockquote|pre|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&[a-z]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * How many characters the user actually wrote, ignoring the markup they wrote them
 * in. This is what both the editor's counter and the server's limit measure.
 * @param {string} html
 * @returns {number}
 */
export function richTextLength(html) {
  return richTextToPlainText(html).length;
}

/**
 * Whether a rich-text value carries no words. An empty editor still emits markup
 * (`<p></p>`), so a bare falsiness check would happily post a blank comment.
 * @param {string} html
 * @returns {boolean}
 */
export function isRichTextEmpty(html) {
  return richTextToPlainText(html) === "";
}

/**
 * Collapse rich text to a single line, for the places that show a bio or comment
 * where markup can't go: a meta/OG description, a one-line list subtitle.
 * @param {string} html
 * @param {number} [max] Truncate beyond this many characters.
 * @returns {string}
 */
export function richTextToLine(html, max = 160) {
  const text = richTextToPlainText(html).replace(/\s*\n\s*/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Whether a stored value is rich-text HTML rather than one of the plain strings
 * written before rich text existed.
 *
 * Everything the editor produces is wrapped in a block tag, so it always starts with
 * one; a plain-text comment realistically never does. Legacy values are rendered as
 * preformatted text (so their newlines survive) instead of being parsed as markup,
 * which is both what their authors meant and what they've always looked like.
 * @param {string} value
 * @returns {boolean}
 */
export function isRichTextHtml(value) {
  return typeof value === "string" && /^\s*<[a-z]/i.test(value);
}
