// Renders a stored rich-text value — a comment body or a profile bio.
//
// Two kinds of value arrive here, and both must render correctly:
//
//   - Rich text: HTML written with RichTextInput and sanitized by the Worker. It is
//     injected as HTML, after a second sanitizing pass (@spelling-creator/core/browser/sanitizeRichText) so that a
//     reader's safety never rests on assuming every row in the database was written
//     by the current server code.
//   - Plain text: every comment and bio written before rich text existed is a bare
//     string. It renders as preformatted text, exactly as it always has, so authors'
//     line breaks survive and nothing is reinterpreted as markup years later.
//
// Media never renders, whichever branch runs: the sanitizer's allow-list has no img,
// video, audio, iframe or svg in it.

import { useMemo } from "react";
import { cn } from "../lib/utils.js";
import { isRichTextHtml } from "@spelling-creator/core/richText";
import { sanitizeRichText } from "@spelling-creator/core/browser/sanitizeRichText";

// Text size for the two places this renders: a comment body (the default,
// smaller) and a profile bio (the one caller that asks for the larger size).
// Formatting spacing itself (paragraph/list/blockquote/code margins) lives in
// the shared .prose-content rules in styles/globals.css — the same rules
// RichTextInput's live editor uses, so a comment looks the same while being
// written and after it's posted.
const VARIANT_CLASSES = {
  body1: "text-base",
  body2: "text-sm",
};

/**
 * @param {object} props
 * @param {string} props.value              The stored body/bio: rich-text HTML, or a
 *                                          plain string from before rich text.
 * @param {string} [props.variant]          "body1" (larger) or "body2" (default).
 * @param {string} [props.className]        Extra classes, merged last.
 */
export default function RichText({ value, variant = "body2", className }) {
  const html = useMemo(
    () => (isRichTextHtml(value) ? sanitizeRichText(value) : ""),
    [value],
  );

  if (!value) return null;

  const sizeClass = VARIANT_CLASSES[variant] ?? VARIANT_CLASSES.body2;

  // Legacy plain text: render as text, never as markup.
  if (!isRichTextHtml(value)) {
    return (
      <p
        className={cn(sizeClass, "whitespace-pre-wrap break-words", className)}
      >
        {value}
      </p>
    );
  }

  // Sanitizing can empty a value out entirely (a "comment" that was nothing but an
  // image, say). Render nothing rather than an empty box.
  if (!html) return null;

  return (
    <div
      className={cn(sizeClass, "prose-content", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
