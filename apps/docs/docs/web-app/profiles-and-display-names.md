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

A bio is a short "about me" shown on your profile page. It's edited in
`BioDialog.jsx` and saved with `POST /profile/bio`, which sanitizes it, caps the
length, runs a profanity check (rejecting with `422` if it fails), and — like the
display name — stores it in `user_metadata.bio` via the Admin API. An empty bio
clears it. Bio is profile-only (never denormalised onto rows).

**Bios are rich text**, written with the same [tiptap](https://tiptap.dev)-based
editor as a comment (`RichTextInput.jsx`) and stored as sanitized HTML: formatting,
lists and links, but **no embedded media** — see [Rich text](./rich-text.md). Two
consequences worth knowing:

- The 500-character cap counts the **text** you wrote, not the markup around it, so
  formatting a bio never eats into the budget. The editor's counter measures it the
  same way the Worker does, so the number you see is the number that's enforced.
- Wherever a bio appears somewhere markup can't go, it is flattened to plain text
  first (`richTextToLine` in `@spelling-creator/core/richText`): the profile's meta/OG description,
  and the one-line subtitle in the followers/following list. A bio rendered as HTML
  into a `<meta content>` would otherwise show up as literal tags in Google snippets
  and link previews.

A bio that is nothing but media (say, a pasted image) sanitizes down to nothing, and
is therefore stored as an empty bio rather than as stray empty markup.

## Profile pages

`ProfilePage.jsx` renders a user's public profile at `/users/:id`. It reads from
the Worker's `GET /profiles/:id`, which returns the user's display name, bio and
follower/following counts, plus their **published** lessons:

```json
{
  "user": {
    "id": "…",
    "displayName": "Jordan",
    "bio": "Speller & teacher.",
    "followerCount": 12,
    "followingCount": 4,
    "isFollowing": false
  },
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
the SPA's own `/users/:id` page. The read stays public; `isFollowing` is only
meaningful when the request carries a session token (it reflects whether _you_
follow this profile, and is `false` for an anonymous view).

Each profile also has a feed at `GET /profiles/:id/feed.xml` — an Atom feed of the
user's lessons and comments (surfaced as "RSS" in the UI).

## Following

Any signed-in user can **follow** another user from their profile page. A follow
is one row in the `follows` table (`follower_id → following_id`, defined in
`apps/api/schema.sql`), keyed by Supabase user id on both sides so it survives a
display-name change. The profile header shows the Follow / Following button (never
for your own profile) plus the follower and following counts.

- **`POST /profiles/:id/follow`** (Bearer) — follow the user. Idempotent
  (`ON CONFLICT DO NOTHING`): re-following is a no-op, so it doesn't create a
  second row or re-notify. A genuinely new follow drops a `follow`
  [notification](./notifications.md) into the followed user's bell. You can't
  follow yourself (`400`) or a user who doesn't exist (`404`).
- **`DELETE /profiles/:id/follow`** (Bearer) — unfollow.

Both return `{ following, followerCount }` so the button and count update without a
refetch. The follower is always taken from the verified session, never the request
body.

The follower/following counts in the profile header are clickable: they open a
**connections dialog** (`FollowListDialog.jsx`) with **Followers** and **Following**
tabs, each row linking to that user's profile. The lists are public:

- **`GET /profiles/:id/followers`** — the users who follow `:id`.
- **`GET /profiles/:id/following`** — the users `:id` follows.

Both return `{ users: [{ id, displayName, bio }] }`, newest-follow first and capped
(each id is resolved to its public profile via the Admin API, so no email leaks).

### Your following feed

The signed-in home dashboard (`HomePage.jsx`) shows a **"From people you follow"**
panel: the recent lessons and comments of everyone you follow, merged newest-first.
It reads `GET /following/activity` (Bearer), which looks up the `following_id`s for
the caller and merges those users' published lessons and comments into the same
`{ id, title, summary, link, updated }` shape the other dashboard feeds use. It
returns an empty feed when you follow no one.

The frontend wrappers are `setFollowing()`, `fetchFollowList()` and
`fetchFollowingActivity()` in `src/lib/users.js`; the Worker handlers are in
`apps/api/src/routes/follows.js`.
