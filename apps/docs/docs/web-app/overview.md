---
title: Overview & features
sidebar_position: 1
---

# Spelling Lesson Maker

A web app for building and printing [**Spelling**](https://i-asc.org) (also known as S2C) lessons.
Create a document, add named sections, and fill each section with text and
images. Export the finished lesson as a Word document (`.docx`) or print it to
PDF.

Built with **React + Vite + MUI**, using [`docx`](https://docx.js.org) for Word
export and [`html2pdf.js`](https://github.com/eKoopmans/html2pdf.js) (via
[`mammoth`](https://github.com/mwilliamson/mammoth.js) docx→HTML conversion) for
PDF printing.

## Features

- **Document title** - name the whole lesson.
- **Add sections** with the floating **+** button; each new section is named in a dialog.
- **Text and image blocks** inside any section. Add, caption, reorder, or delete them.
- **Search images** - find free Pixabay images from within a section and insert
  one with a click (see [Search images](./search-images.md)).
- **Question blocks** - add structured questions in five types (see [Question blocks](./question-blocks.md)).
- **AI text suggestions** - generate a block of lesson text from a section's
  title with one click (see [AI text suggestions](./ai-text-suggestions.md)).
- **AI question suggestions** - generate a structured question of any type from
  a section's title and existing text (see [AI question suggestions](./ai-question-suggestions.md)).
- **AI lesson ideas** - get a batch of lesson topic suggestions for an age range
  to start from a blank document (see [AI lesson ideas](./ai-lesson-ideas.md)).
- **Lesson summaries** - summarise a published lesson with the browser's built-in
  AI, running entirely on the reader's own device (no server, no cost). Only
  appears on browsers that can actually run it (see
  [Lesson summaries](./lesson-summaries.md)).
- **Reorder / delete** sections and blocks with inline controls. Blocks can also
  be dragged by their grab handle, both within a section and **from one section
  into another** (an empty section shows a drop zone that takes the block). An
  insertion line shows where the block will land — anywhere in a section,
  including the gaps between blocks — and holding the pointer near the top or
  bottom of the window scrolls the page on its own, so a block can be carried to
  a section well past the visible part of a long lesson.
- **Export DOCX** - downloads a formatted `.docx`.
- **Print PDF** - builds the docx, converts it to HTML with mammoth, then renders
  a PDF with html2pdf.js so the printout mirrors the Word document.
- **Save to Google Docs** - signs in with Google (OAuth2) and uploads the docx to
  the user's Drive, converting it to a native Google Doc (see [Save to Google Docs](./save-to-google-docs.md)).
- **Lesson hub** - browse lessons other users have published, preview any of them,
  and publish your own once signed in (see [Lesson hub & accounts](./lesson-hub-and-accounts.md)).
- **Comments & ratings** - discuss a published lesson in a threaded comment box,
  and leave a 1–5 star rating with your comment; the lesson page shows the average
  (see [Lesson hub & accounts](./lesson-hub-and-accounts.md)). Comments (and bios)
  are **rich text** — formatting and links, but no embedded media — and you can edit
  your own after posting (see [Rich text](./rich-text.md)).
- **Accounts** - passwordless magic-link sign-in (Supabase Auth) on a dedicated
  login page; required only to publish to the hub (see [Lesson hub & accounts](./lesson-hub-and-accounts.md)).
- **Profiles & display names** - every user picks a public display name and an
  optional rich-text bio, with a public profile page listing their lessons. Signed-in users
  can **follow** each other, and a home-page feed shows the activity of people you
  follow (see [Profiles & display names](./profiles-and-display-names.md#following)).
- **Notifications** - an in-app bell for replies, comments on your lessons, new
  followers, and links sent to you (see [Notifications](./notifications.md)).
- **Moderation** - moderator/admin tools for comments, shadowbanning, and bans
  (see [Moderation](./moderation.md)).
- **Live collaboration** - invite others to edit a lesson with you in real time
  over a server-side room (a Cloudflare Durable Object, one WebSocket per
  participant), with live cursors and an in-session chat panel. People you invite
  only start collaborating once you add them to the lesson (see
  [Live collaboration](./live-collaboration.md)).
- **Version history** - every lesson is a real git repository in the browser, one
  file per content block. Edits are committed automatically as you pause, so you
  can browse every version and restore any of them. Forking a lesson **clones**
  its repository, and a fork can later pull the original's changes in — merged
  block by block, with edits to different blocks (or different parts of the same
  block) merging automatically (see
  [Version history](/monorepo/version-history)).
- **Auto-save** - your work is kept in IndexedDB between reloads (images as binary
  blobs, so large drafts aren't capped by `localStorage`'s ~5 MB quota).
