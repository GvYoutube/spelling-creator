---
title: Moderation
sidebar_position: 12
---

# Moderation

On top of the automatic profanity filtering applied to comments, bios, and
display names, the hub has a **moderation** layer with two privilege tiers and a
dedicated moderation queue at `/moderation` (`ModerationPage.jsx`). The page is
gated to privileged users and is disallowed for robots.

The browser holds no authority of its own: it asks the Worker
`GET /moderation/whoami` what the caller is allowed to do and renders accordingly,
and the Worker **re-derives the caller's role from the database on every
privileged request**, so a tampered client can never grant itself power.

## Roles

Roles live in the `user_roles` table (`apps/api/schema.sql`). A normal signed-in
user is a plain author who can only touch their own content. Above that:

- **Moderator** — delete any comment, **shadowban** a lesson, ban users by name,
  and **request** that a lesson be fully deleted.
- **Admin** — everything a moderator can do, plus: add moderators, approve a
  moderator's lesson-deletion request, fully delete a lesson, and ban users by IP.

There is deliberately **no in-app way to create an admin** — admins are seeded by
hand in the Supabase SQL editor (see the snippet at the bottom of `schema.sql`).
Admins can add moderators (`POST /moderation/moderators`); `granted_by` records
which admin added each one.

## Shadowbanning vs. deletion

A **shadowbanned** lesson (`lessons.shadowbanned`) is dropped from the public hub
listing and from public single-lesson reads (it 404s to everyone except its
author and mods/admins), so the author still sees it as normal and doesn't realise
it's hidden. This is reversible and any moderator can do it.

A **full deletion** is destructive, so moderators can't do it directly: a
moderator files a row in `lesson_delete_requests` (status `pending`), and an admin
approves it (which deletes the lesson) or denies it.

## Bans

- **Name bans** (`banned_names`, created by moderators) block any account whose
  display name matches from commenting or publishing/editing. Names are stored
  normalised (lower-cased, trimmed) for an exact, case-insensitive match.
- **IP bans** (`banned_ips`, created by admins) block any request from an address.

Both are checked at the top of the content-creating Worker routes. To support
"ban this user by IP" from a piece of their content, the Worker captures the
creator's IP (`cf-connecting-ip`) into `lessons.author_ip` / `comments.author_ip`.
That column is **only ever surfaced to mods/admins**, never in public responses.

## Worker endpoints

All require a `Bearer <Supabase JWT>` and the appropriate role; the frontend
wrapper is `src/lib/moderation.js`.

| Method & path                                     | Role  | What it does                                 |
| ------------------------------------------------- | ----- | -------------------------------------------- |
| `GET /moderation/whoami`                          | any   | The caller's capabilities (mod/admin flags). |
| `DELETE /moderation/comments/:id`                 | mod   | Delete any comment.                          |
| `POST /moderation/lessons/:id/shadowban`          | mod   | Hide/unhide a lesson from the public hub.    |
| `GET /moderation/lessons/shadowbanned`            | mod   | List shadowbanned lessons.                   |
| `POST /moderation/lessons/:id/delete-request`     | mod   | File a request to fully delete a lesson.     |
| `GET /moderation/delete-requests`                 | admin | List pending deletion requests.              |
| `POST /moderation/delete-requests/:id/approve`    | admin | Approve (and delete) a request.              |
| `DELETE /moderation/lessons/:id`                  | admin | Fully delete a lesson.                       |
| `GET` / `POST` / `DELETE /moderation/bans/name…`  | mod   | List / add / remove name bans.               |
| `GET` / `POST` / `DELETE /moderation/bans/ip…`    | admin | List / add / remove IP bans.                 |
| `GET` / `POST` / `DELETE /moderation/moderators…` | admin | List / add / remove moderators.              |
