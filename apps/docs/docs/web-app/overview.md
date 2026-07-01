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
- **Reorder / delete** sections and blocks with inline controls.
- **Export DOCX** - downloads a formatted `.docx`.
- **Print PDF** - builds the docx, converts it to HTML with mammoth, then renders
  a PDF with html2pdf.js so the printout mirrors the Word document.
- **Save to Google Docs** - signs in with Google (OAuth2) and uploads the docx to
  the user's Drive, converting it to a native Google Doc (see [Save to Google Docs](./save-to-google-docs.md)).
- **Lesson hub** - browse lessons other users have published, preview any of them,
  and publish your own once signed in (see [Lesson hub & accounts](./lesson-hub-and-accounts.md)).
- **Accounts** - passwordless magic-link sign-in (Supabase Auth) on a dedicated
  login page; required only to publish to the hub (see [Lesson hub & accounts](./lesson-hub-and-accounts.md)).
- **Profiles & display names** - every user picks a public display name and an
  optional bio, with a public profile page listing their lessons. Signed-in users
  can **follow** each other, and a home-page feed shows the activity of people you
  follow (see [Profiles & display names](./profiles-and-display-names.md#following)).
- **Notifications** - an in-app bell for replies, comments on your lessons, new
  followers, and links sent to you (see [Notifications](./notifications.md)).
- **Moderation** - moderator/admin tools for comments, shadowbanning, and bans
  (see [Moderation](./moderation.md)).
- **Live collaboration** - invite others to edit a lesson with you in real time
  over a peer-to-peer (PeerJS/WebRTC) connection, with live cursors and an
  in-session chat panel. People you invite only start collaborating once you add
  them to the lesson (see [Live collaboration](./live-collaboration.md)).
- **Auto-save** - your work is kept in `localStorage` between reloads.
