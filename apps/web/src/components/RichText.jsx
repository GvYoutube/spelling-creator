// Renders a stored rich-text value — a comment body or a profile bio.
//
// Two kinds of value arrive here, and both must render correctly:
//
//   - Rich text: HTML written with RichTextInput and sanitized by the Worker. It is
//     injected as HTML, after a second sanitizing pass (lib/richText.js) so that a
//     reader's safety never rests on assuming every row in the database was written
//     by the current server code.
//   - Plain text: every comment and bio written before rich text existed is a bare
//     string. It renders as preformatted text, exactly as it always has, so authors'
//     line breaks survive and nothing is reinterpreted as markup years later.
//
// Media never renders, whichever branch runs: the sanitizer's allow-list has no img,
// video, audio, iframe or svg in it.

import { useMemo } from "react";
import Typography from "@mui/material/Typography";
import { isRichTextHtml, sanitizeRichText } from "../lib/richText.js";

// Typography for the formatting the editor can produce. The editor wraps everything
// in block tags, so the first and last child have their margins collapsed — otherwise
// every comment would carry a blank line above and below it.
const RICH_TEXT_SX = {
  wordBreak: "break-word",
  "& > :first-of-type": { mt: 0 },
  "& > :last-child": { mb: 0 },
  "& p": { my: 1 },
  "& ul, & ol": { my: 1, pl: 3 },
  "& li > p": { my: 0 },
  "& blockquote": {
    my: 1,
    ml: 0,
    pl: 1.5,
    borderLeft: 3,
    borderColor: "divider",
    color: "text.secondary",
  },
  "& code": {
    fontFamily: "monospace",
    fontSize: "0.875em",
    bgcolor: "action.hover",
    px: 0.5,
    py: 0.25,
    borderRadius: 0.5,
  },
  "& pre": {
    my: 1,
    p: 1,
    bgcolor: "action.hover",
    borderRadius: 1,
    overflowX: "auto",
  },
  "& pre code": { bgcolor: "transparent", p: 0 },
  "& a": { color: "primary.main" },
};

/**
 * @param {object} props
 * @param {string} props.value              The stored body/bio: rich-text HTML, or a
 *                                          plain string from before rich text.
 * @param {string} [props.variant]          MUI Typography variant.
 * @param {object} [props.sx]               Extra styles, merged last.
 */
export default function RichText({ value, variant = "body2", sx }) {
  const html = useMemo(
    () => (isRichTextHtml(value) ? sanitizeRichText(value) : ""),
    [value],
  );

  if (!value) return null;

  // Legacy plain text: render as text, never as markup.
  if (!isRichTextHtml(value)) {
    return (
      <Typography
        variant={variant}
        sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word", ...sx }}
      >
        {value}
      </Typography>
    );
  }

  // Sanitizing can empty a value out entirely (a "comment" that was nothing but an
  // image, say). Render nothing rather than an empty box.
  if (!html) return null;

  return (
    <Typography
      variant={variant}
      component="div"
      sx={{ ...RICH_TEXT_SX, ...sx }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
