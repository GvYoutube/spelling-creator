// The formatting toolbar for RichTextInput.jsx, built directly on
// @tiptap/react instead of mui-tiptap's <RichTextEditor renderControls>. The
// feature set is unchanged: marks, two list types, blockquote, a link editor,
// and remove-formatting — the same bounded set mui-tiptap's toolbar offered.
//
// Link editing is simplified from the old LinkBubbleMenu: instead of a bubble
// that auto-appears when the cursor enters a link, the toolbar's link button
// opens a small popover to add/edit/remove a link for the current selection
// (or the link under the cursor, since Link.extendMarkRange covers that).
// Clicking a link in the text still just places the cursor — openOnClick is
// still false — so editing always goes through this one button.

import { useState } from "react";
import { useEditorState } from "@tiptap/react";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  Quote,
  Link2,
  RemoveFormatting,
} from "lucide-react";
import { Toggle } from "./ui/toggle.jsx";
import { Button } from "./ui/button.jsx";
import { Separator } from "./ui/separator.jsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.jsx";
import { Input } from "./ui/input.jsx";

function useToolbarState(editor) {
  return useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      underline: editor.isActive("underline"),
      strike: editor.isActive("strike"),
      code: editor.isActive("code"),
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      blockquote: editor.isActive("blockquote"),
      link: editor.isActive("link"),
      linkHref: editor.getAttributes("link").href ?? "",
    }),
  });
}

function MarkButton({ pressed, onPressedChange, label, icon: Icon }) {
  return (
    <Toggle
      size="sm"
      pressed={pressed}
      onPressedChange={onPressedChange}
      aria-label={label}
    >
      <Icon />
    </Toggle>
  );
}

function LinkButton({ editor, active, href }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(href);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setUrl(href);
      }}
    >
      <PopoverTrigger asChild>
        <Toggle size="sm" pressed={active} aria-label="Link">
          <Link2 />
        </Toggle>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) {
              editor
                .chain()
                .focus()
                .extendMarkRange("link")
                .setLink({ href: url.trim() })
                .run();
            }
            setOpen(false);
          }}
        >
          <Input
            autoFocus
            type="url"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" size="sm">
            {active ? "Update" : "Add"}
          </Button>
        </form>
        {active && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 w-full text-destructive hover:text-destructive"
            onClick={() => {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              setOpen(false);
            }}
          >
            Remove link
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default function RichTextToolbar({ editor }) {
  const state = useToolbarState(editor);

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border p-1.5">
      <MarkButton
        pressed={state.bold}
        onPressedChange={() => editor.chain().focus().toggleBold().run()}
        label="Bold"
        icon={Bold}
      />
      <MarkButton
        pressed={state.italic}
        onPressedChange={() => editor.chain().focus().toggleItalic().run()}
        label="Italic"
        icon={Italic}
      />
      <MarkButton
        pressed={state.underline}
        onPressedChange={() => editor.chain().focus().toggleUnderline().run()}
        label="Underline"
        icon={UnderlineIcon}
      />
      <MarkButton
        pressed={state.strike}
        onPressedChange={() => editor.chain().focus().toggleStrike().run()}
        label="Strikethrough"
        icon={Strikethrough}
      />
      <MarkButton
        pressed={state.code}
        onPressedChange={() => editor.chain().focus().toggleCode().run()}
        label="Code"
        icon={Code}
      />

      <Separator orientation="vertical" className="mx-1 h-6" />

      <MarkButton
        pressed={state.bulletList}
        onPressedChange={() => editor.chain().focus().toggleBulletList().run()}
        label="Bulleted list"
        icon={List}
      />
      <MarkButton
        pressed={state.orderedList}
        onPressedChange={() => editor.chain().focus().toggleOrderedList().run()}
        label="Numbered list"
        icon={ListOrdered}
      />
      <MarkButton
        pressed={state.blockquote}
        onPressedChange={() => editor.chain().focus().toggleBlockquote().run()}
        label="Quote"
        icon={Quote}
      />

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* A link is the only thing a user may embed. The sanitizer keeps only
          http/https/mailto targets, and marks every one nofollow. */}
      <LinkButton editor={editor} active={state.link} href={state.linkHref} />

      <Separator orientation="vertical" className="mx-1 h-6" />

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Remove formatting"
        onClick={() =>
          editor.chain().focus().unsetAllMarks().clearNodes().run()
        }
      >
        <RemoveFormatting />
      </Button>
    </div>
  );
}
