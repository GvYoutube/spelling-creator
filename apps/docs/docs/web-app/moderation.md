---
title: Moderation
---

# Moderation

On top of the automatic profanity filtering applied to comments, bios, and
display names, the hub has a **moderation** layer with two privilege tiers and a
dedicated moderation queue at `/moderation` (`ModerationPage.jsx`). The page is
gated to privileged users and is disallowed for robots.

The browser holds no authority of its own: it asks the Worker
`GET /mod/whoami` what the caller is allowed to do and renders accordingly,
and the Worker **re-derives the caller's role from the database on every
privileged request**, so a tampered client can never grant itself power.
(The Worker's moderation API lives at `/mod`, not `/moderation` — it's named
differently on purpose so it can't collide with this page's own `/moderation`
route; see the registration comment in `apps/api/src/index.js`.)

## Roles

Roles live in the `user_roles` table (`apps/api/schema.sql`). A normal signed-in
user is a plain author who can only touch their own content. Above that:

- **Moderator** — delete any comment, close any
  [proposed change](./pull-requests.md), **shadowban** a lesson, ban users by
  name, and **request** that a lesson be fully deleted.
- **Admin** — everything a moderator can do, plus: add moderators, approve a
  moderator's lesson-deletion request, fully delete a lesson, and ban users by IP.

Note what is _not_ on either list: **editing** someone else's comment. A comment can
only be edited by the person who wrote it (see [Rich text](./rich-text.md)) — a
moderator's power over a bad comment is to delete it, not to rewrite it under its
author's name.

For the same reason, a moderator can **close** a proposed change but never
**merge** one. Merging writes a lesson under its author's name, which is
authorship, not moderation; only that author and the collaborators they trust can
do it.

There is deliberately **no in-app way to create an admin** — admins are seeded by
hand in the Supabase SQL editor (see the snippet at the bottom of `schema.sql`).
Admins can add moderators (`POST /mod/moderators`); `granted_by` records
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
wrapper is `@spelling-creator/core/moderation`.

| Method & path                              | Role  | What it does                                  |
| ------------------------------------------ | ----- | --------------------------------------------- |
| `GET /mod/whoami`                          | any   | The caller's capabilities (mod/admin flags).  |
| `DELETE /mod/comments/:id`                 | mod   | Delete any comment.                           |
| `POST /mod/lessons/:id/shadowban`          | mod   | Hide/unhide a lesson from the public hub.     |
| `GET /mod/lessons/shadowbanned`            | mod   | List shadowbanned lessons.                    |
| `POST /mod/lessons/:id/delete-request`     | mod   | File a request to fully delete a lesson.      |
| `GET /mod/delete-requests`                 | admin | List pending deletion requests.               |
| `POST /mod/delete-requests/:id/approve`    | admin | Approve (and delete) a request.               |
| `DELETE /mod/lessons/:id`                  | admin | Fully delete a lesson.                        |
| `GET` / `POST` / `DELETE /mod/bans/name…`  | mod   | List / add / remove name bans.                |
| `GET` / `POST` / `DELETE /mod/bans/ip…`    | admin | List / add / remove IP bans.                  |
| `GET` / `POST` / `DELETE /mod/moderators…` | admin | List / add / remove moderators.               |
| `POST /mod/password`                       | admin | Set a user's password (self-hosted recovery). |

## Setting a password

An instance that signs people in with a username and has no mail server has
nowhere to send a reset link, so a forgotten password would otherwise be
unrecoverable short of the database. An admin can set one from this page —
identifying the person by username or by email, whichever they are known by.

It is **admin-only, never moderator**. Setting somebody's password is taking
their account, which is a different kind of power from hiding a lesson. An admin
may reset their own and anybody below them, but not another admin's: admins are
peers, and taking a peer's account is an escalation the tier was never meant to
allow. The section only appears at all on an instance that uses passwords —
there is nothing to set on a magic-link one.

There is no audit table, so the action leaves a line in the server log naming
who reset whom. It records identities only, never the password.

Two limits worth knowing. The last admin locking themselves out is a database
problem, not an in-app one. And the reset changes the password without
necessarily ending sessions already open elsewhere, so treat it as recovery from
forgetfulness rather than as containment of a compromised account. See
[Self-hosting](../monorepo/self-hosting.md).
