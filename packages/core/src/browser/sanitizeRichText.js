// Rich text on the browser side — the counterpart to apps/api/src/lib/richtext.js.
//
// Comments and bios are rich text: HTML written with tiptap (RichTextInput.jsx)
// and rendered back as HTML (RichText.jsx). One job lives here:
//
//   `sanitizeRichText` — a second, independent sanitizing pass at render time.
//   The Worker already sanitizes everything it stores, and that is the boundary
//   that actually protects us. This pass exists because the render path uses
//   dangerouslySetInnerHTML, and it should not be the case that the safety of a
//   reader's session depends on every row in the database having been written by
//   the current version of the Worker. Rows predating rich text, rows written by
//   some future path that forgets to sanitize, a bug in the allow-list — all are
//   caught here, at the last moment before the HTML becomes DOM.
//
// The policy it enforces — which tags survive, which link schemes are real
// links, what a link is rewritten to carry — is shared with the Worker in
// @spelling-creator/core/richText, as is the flattening to plain text. Only the
// parser differs: DOMPurify here, HTMLRewriter there.

import DOMPurify from "dompurify";
import {
  LINK_REL,
  LINK_TARGET,
  MEDIA_TAGS,
  RICH_TEXT_TAGS,
  SAFE_LINK_PROTOCOLS,
} from "../richText.js";

// Only links carry attributes, and only these. No `src`, no `style`, no `on*`.
const ALLOWED_ATTR = ["href", "target", "rel"];

// Redundant given the allow-list, but states the product rule where a future
// reader will look for it: no embedded media, ever. Plus the tags whose *content*
// is code rather than prose.
const FORBID_TAGS = [
  ...MEDIA_TAGS,
  "iframe",
  "object",
  "embed",
  "script",
  "style",
];

// DOMPurify is a wrapper around a real DOM: with no `window` to bind to, the
// module's default export is an inert stub with no `addHook` and no `sanitize`.
// That is fine — this is a `browser/` module and by the boundary in
// .oxlintrc.json nothing outside a browser may call it. It has to survive being
// *imported* without one, though, because the server render bundles the same
// component tree the browser does (RichText.jsx, which defers the actual
// sanitizing to after mount for exactly this reason).
const hasDom = typeof window !== "undefined" && typeof document !== "undefined";

// User-generated links open away from the app, carry no SEO value for spammers, and
// can't reach back through window.opener. The Worker sets these too; we re-assert
// them here so a link that reaches us any other way still gets them.
if (hasDom) {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", LINK_TARGET);
      node.setAttribute("rel", LINK_REL);
    }
  });
}

/**
 * Sanitize rich-text HTML for rendering. See the note above on why this runs even
 * though the Worker already sanitized on write.
 * @param {string} html
 * @returns {string} HTML safe to inject.
 */
export function sanitizeRichText(html) {
  if (!html) return "";
  if (!hasDom) {
    // Loud rather than a silent pass-through: returning the input unsanitized
    // would hand a caller exactly the unchecked HTML this function exists to
    // stop, and React does not re-check dangerouslySetInnerHTML on hydration,
    // so it would never be scrubbed afterwards either.
    throw new Error("sanitizeRichText needs a DOM; call it from the browser.");
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: RICH_TEXT_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: SAFE_LINK_PROTOCOLS,
    FORBID_TAGS,
  });
}
