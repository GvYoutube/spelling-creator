// The rich-text editor used to write comments and bios, built directly on
// @tiptap/react (see RichTextToolbar.jsx for why this no longer wraps
// mui-tiptap's RichTextEditor). Both call sites get the same toolbar, the
// same limits and the same rules.
//
// No media, by design, and enforced three ways here:
//   - the toolbar has no image/media button, so nothing offers it;
//   - no Image (or other media) extension is registered, so the tiptap schema has no
//     node to put one in — a pasted <img> is dropped on the way in;
//   - EDITOR_PROPS refuses dropped and pasted *files*, which is what stops the
//     browser's default "helpfully inline this screenshot as a data: URI" behaviour.
//
// None of that is the real boundary, though: a determined client can ignore this
// component and POST whatever HTML it likes. The Worker's sanitizer is what actually
// enforces the rule (apps/api/src/lib/richtext.js). This is the honest-user half, and
// exists so the UI never offers something the server would only strip back out.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { cn } from "../lib/utils.js";
import { richTextLength } from "@spelling-creator/core/richText";
import RichTextToolbar from "./RichTextToolbar.jsx";

// The editable feature set: everything the sanitizer's allow-list keeps, and nothing
// it would only strip again on the way to the database.
//   - headings and horizontal rules are off — a comment is a paragraph, not a document
//   - code *blocks* are off; the inline `code` mark stays
//   - no media extension is registered at all (see the file header)
const BASE_EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    horizontalRule: false,
    codeBlock: false,
  }),
  Underline,
  Link.configure({
    // Editing a link always goes through the toolbar's link popover; clicking
    // one inside the editor should place the cursor, not navigate away
    // mid-sentence.
    openOnClick: false,
    autolink: true,
    protocols: ["http", "https", "mailto"],
    HTMLAttributes: {
      target: "_blank",
      rel: "nofollow ugc noopener noreferrer",
    },
  }),
];

// Refuse dropped and pasted files. Returning true tells ProseMirror the event is
// handled, so nothing is inserted and the browser doesn't fall back to its default.
const EDITOR_PROPS = {
  handleDrop: (_view, event) => Boolean(event.dataTransfer?.files?.length),
  handlePaste: (_view, event) => Boolean(event.clipboardData?.files?.length),
};

/**
 * @param {object}   props
 * @param {string}   props.value      Current HTML. Seeds the editor's initial content;
 *                                    tiptap owns the content after mount, so remount
 *                                    (via a changing `key`) to force it back in sync —
 *                                    that's how the comment box clears after posting.
 * @param {(html: string) => void} props.onChange  Called with the editor's HTML.
 * @param {number}   props.maxLength  Character budget, counted over the text the user
 *                                    wrote rather than the markup around it, so it
 *                                    matches what the server enforces.
 * @param {string}   [props.label]    Accessible name for the editable area.
 * @param {string}   [props.placeholder]  Shown while the editor is empty.
 * @param {boolean}  [props.disabled]
 * @param {boolean}  [props.autoFocus]
 */
export default function RichTextInput({
  value,
  onChange,
  maxLength,
  label,
  placeholder = "",
  disabled = false,
  autoFocus = false,
}) {
  const { t } = useTranslation("richText");

  // Count what the server counts, so the number the user sees is the number that
  // decides whether their comment is accepted.
  const length = richTextLength(value);
  const overLimit = length > maxLength;

  const extensions = useMemo(
    () => [...BASE_EXTENSIONS, Placeholder.configure({ placeholder })],
    [placeholder],
  );

  const editorProps = useMemo(
    () => ({
      ...EDITOR_PROPS,
      attributes: {
        class: "prose-editor min-h-24 px-3 py-2 text-sm outline-none",
        ...(label ? { "aria-label": label } : {}),
      },
    }),
    [label],
  );

  const editor = useEditor({
    extensions,
    content: value,
    editable: !disabled,
    editorProps,
    autofocus: autoFocus,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  return (
    <div>
      <div
        className={cn(
          "overflow-hidden rounded-md border border-input transition-[color,box-shadow]",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          disabled && "opacity-50",
        )}
      >
        {editor && !disabled && <RichTextToolbar editor={editor} />}
        <EditorContent editor={editor} />
      </div>

      <p
        className={cn(
          "mt-1 text-right text-xs",
          overLimit ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {t("input.characterCount", { length, maxLength })}
      </p>
    </div>
  );
}
