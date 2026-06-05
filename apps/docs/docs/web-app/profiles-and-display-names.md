---
title: Profiles & display names
sidebar_position: 10
---

# Profiles & display names

Every signed-in user has a **public display name** and an optional **bio**, and a
public **profile page** that lists the lessons they've published. None of this
exposes the user's email — the hub shows the chosen display name everywhere an
author or commenter is named.

## Display names

The first time a signed-in user reaches the app they're asked to pick a display
name before they can use it. `DisplayNameGate.jsx` enforces this (wrapping the
whole app in `main.jsx`), and `DisplayNameDialog.jsx` is the picker; a user can
change their name later from the account menu.

The name is **not** a database column — it's stored in the Supabase user's
`user_metadata.display_name`. The browser can't write metadata directly; it calls
the Worker's `POST /profile/display-name`, which validates the name (and runs the
same profanity / name-ban checks as publishing) and writes it through the Supabase
**Admin API**. Because `author` is denormalised onto each lesson and comment row
for fast listing, changing your name also backfills it onto your existing rows.

## Bios

A bio is a short free-text "about me" shown on your profile page. It's edited in
`BioDialog.jsx` and saved with `POST /profile/bio`, which caps the length, runs a
profanity check (rejecting with `422` if it fails), and — like the display name —
stores it in `user_metadata.bio` via the Admin API. An empty bio clears it. Bio
is profile-only (never denormalised onto rows).

## Profile pages

`ProfilePage.jsx` renders a user's public profile at `/users/:id`. It reads from
the Worker's `GET /profiles/:id`, which returns the user's display name and bio
plus their **published** lessons:

```json
{
  "user": { "id": "…", "displayName": "Jordan", "bio": "Speller & teacher." },
  "lessons": [
    {
      "id": "…",
      "title": "…",
      "author": "…",
      "sectionCount": 4,
      "createdAt": "…"
    }
  ]
}
```

The Worker resolves the profile via the Supabase Admin API and **never returns the
email** — only the display name (falling back to `"Anonymous"`) and bio. The
endpoint is served under `/profiles/:id` on the Worker so it doesn't collide with
the SPA's own `/users/:id` page.

Each profile also has a feed at `GET /profiles/:id/feed.xml` — an Atom feed of the
user's lessons and comments (surfaced as "RSS" in the UI).
