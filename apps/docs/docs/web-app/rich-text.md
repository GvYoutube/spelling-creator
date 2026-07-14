---
title: Rich text (comments & bios)
sidebar_position: 9.5
---

# Rich text (comments & bios)

The two things users write about each other — **lesson comments** and **profile
bios** — are rich text. Both are authored with
[mui-tiptap](https://github.com/sjdemartini/mui-tiptap) and stored as **sanitized
HTML**.

Users can format text and link out. They **cannot embed media**: no images, video,
audio or frames, whether uploaded, dragged in, pasted, or hand-written into a
request. That is a deliberate product rule, and most of this page is about where it
is actually enforced.

## What a user can write

| Available                                             | Not available                                   |
| ----------------------------------------------------- | ----------------------------------------------- |
| Bold, italic, underline, strikethrough, inline `code` | Images, video, audio, `<iframe>`, `<svg>`       |
| Bulleted and numbered lists, blockquotes              | Headings, horizontal rules, code blocks, tables |
| Links (http/https/mailto)                             | Any attribute other than a validated `href`     |

Headings and tables are left out on purpose: a comment is a paragraph, not a
document.

## The pieces

| File                                        | Role                                                         |
| ------------------------------------------- | ------------------------------------------------------------ |
| `apps/api/src/lib/richtext.js`              | **The boundary.** Sanitizes on write; flattens HTML to text. |
| `apps/api/src/lib/richtext.test.js`         | Its tests — media, XSS, links, legacy values.                |
| `apps/web/src/components/RichTextInput.jsx` | The editor (toolbar, limits, no media affordances).          |
| `apps/web/src/components/RichText.jsx`      | The renderer, for both rich text and legacy plain text.      |
| `apps/web/src/lib/richText.js`              | Render-time sanitizing (DOMPurify) + text flattening.        |

## Where "no media" is actually enforced

The editor has no image button — but a toolbar is a suggestion, not a boundary.
Anyone can `POST` hand-written HTML straight at the Worker, so the rule is enforced
in four places, only the third of which is load-bearing:

1. **No media button** in the toolbar, so nothing offers it.
2. **No image/media node in the tiptap schema**, so a pasted `<img>` has nowhere to
   go and is dropped on the way in; `handlePaste`/`handleDrop` additionally refuse
   dropped and pasted _files_, which is what stops the browser from helpfully
   inlining a dragged-in screenshot as a giant `data:` URI.
3. **The Worker's sanitizer** (`sanitizeRichText`) — the only one of these a hostile
   client cannot skip. It is an **allow-list**: anything not explicitly permitted is
   dropped, so a tag nobody thought of fails closed. Media tags are removed along
   with their content, and every attribute is stripped except a validated `href`.
4. **A second sanitizing pass at render time** (DOMPurify, in `lib/richText.js`).
   The render path uses `dangerouslySetInnerHTML`, and a reader's safety shouldn't
   depend on assuming every row in the database was written by the current server
   code. Rows predating rich text, or written by some future path that forgets to
   sanitize, are caught here.

The sanitizer is built on
[HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/),
the Workers runtime's native streaming HTML parser. A real parser sees the same tag
soup a browser would; a regex-based "sanitizer" is the classic way to ship an XSS
hole (`<img/src=x onerror=…>`, `<scr<script>ipt>`). It also means no dependency.

### Links

Links are the one thing a user may embed. Only `http:`, `https:` and `mailto:`
targets survive — `javascript:` executes, and `data:` is an HTML/media smuggling
channel — and the check is run against the URL with control characters stripped, so
`java\tscript:` doesn't sneak past it. Every surviving link is rewritten to carry
`target="_blank"` and `rel="nofollow ugc noopener noreferrer"`: user-generated links
open away from the app, earn spammers no SEO value, and can't reach back through
`window.opener`. A link whose target fails the check keeps its words and loses the
link.

## Text, not markup

Everything downstream of storage wants text, not markup, and gets it from
`richTextToPlain` (Worker) / `richTextToPlainText` (browser):

- **The profanity filter** scans words, not tag names and URLs.
- **Length limits** (2000 characters for a comment, 500 for a bio) count what the
  user _wrote_, so wrapping a sentence in `<strong>` never costs them their budget.
  The editor's live counter uses the same flattening, so the number a user sees is
  the number the server enforces — the two implementations mirror each other
  deliberately, and must be changed together.
- **The Atom feed's `<summary>`**, **notification bodies**, the **profile meta/OG
  description**, and the **one-line bio** in the followers list are all plain-text
  contexts. Markup rendered into them would appear as literal escaped tags in feed
  readers, search snippets and link previews.

A comment or bio consisting of nothing but media sanitizes down to nothing, and is
rejected (or, for a bio, stored as empty) rather than saved as blank markup.

## Editing

An author may **edit their own comment** after posting
(`PATCH /lessons/:id/comments/:commentId`). Ownership is decided by comparing the
stored `author_id` against the verified JWT, never by anything the request claims.
The new body runs through the identical sanitize → length → profanity pipeline as a
fresh post, so editing is not a way to launder content past the rules that applied
when it was written.

A successful edit stamps `comments.edited_at`, which the thread renders as an
**"edited"** marker — a comment never changes silently under someone who already
read or replied to it. **Moderators cannot edit a comment**, only delete it
([Moderation](./moderation.md)): rewriting someone's words under their own name is a
power worth not having.

Bios have always been editable, and are simply saved again through
`POST /profile/bio`.

## Values written before rich text

Every comment and bio predating this feature is a bare plain-text string. They are
detected (`isRichTextHtml`) and rendered **as text**, with `white-space: pre-wrap`
so their line breaks survive — exactly as they always looked. They are never
reinterpreted as markup years after the fact. The flattening helpers pass them
through unchanged, so a plain-text value with no tags is its own plain text.
