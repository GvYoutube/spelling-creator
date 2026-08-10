---
title: Notifications
---

# Notifications

Signed-in users get a **notification bell** in the app header
(`NotificationBell.jsx`). It polls the Worker for the caller's notifications,
shows an unread badge, and lets you open and mark them read. The browser never
queries the table directly — everything goes through the Worker's
`/notifications` endpoints, which scope every query to the signed-in caller.

## What triggers one

- **`comment`** — someone replied to your comment, or commented on a lesson you
  published. The Worker creates these inside its comment handler when a comment is
  posted (notifying the parent comment's author and the lesson's author). Comments
  are [rich text](./rich-text.md), but the notification's `body` carries the comment
  **flattened to plain text** — the bell renders it as text, so markup would show up
  there as literal tags.
- **`link`** — another signed-in user sent you a link via **send link to user**
  (an optional short message can ride along, and is profanity-checked server-side).
  Because the recipient may not have an account id yet, a `link` notification is
  addressed by **email**, so it's waiting for them the next time they sign in.
- **`follow`** — someone started following you. The Worker creates this inside its
  follow handler (`POST /profiles/:id/follow`) when a _new_ follow edge is added;
  re-following is a no-op and doesn't re-notify. Its link opens the follower's
  profile. See [Following](./profiles-and-display-names.md#following).
- **`pull_request`** — someone proposed changes to a lesson you published, or the
  proposal _you_ made was merged or closed. The three are one type because they're
  one conversation; the title says which happened and the link opens the lesson.
  Nothing is sent until a proposal actually has changes in it (an upload that
  never finished notifies nobody), and withdrawing your own never notifies you.
  See [Pull requests](./pull-requests.md).
- **`lesson_update`** — a trusted collaborator saved a lesson you published. It
  changed under you and you didn't do it, so you're told. (Merging a proposal into
  your lesson also lands as one of these, from whoever merged it.)

## How it's stored

Notifications live in the `notifications` table (defined in `apps/api/schema.sql`).
A notification reaches its recipient either by their auth user id (`user_id`) or
by their email (`recipient_email`, used by send-link before that person's id is
known). Each row carries a `type`, `title`, `body`, optional `link`, a `read`
flag, and a timestamp.

## Worker endpoints

| Method & path                   | Auth                    | What it does                                                             |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `GET /notifications`            | `Bearer <Supabase JWT>` | The caller's notifications, newest first (by user id **or** email).      |
| `POST /notifications/read`      | `Bearer <Supabase JWT>` | Marks the caller's notifications (or a given one) as read.               |
| `POST /notifications/send-link` | `Bearer <Supabase JWT>` | Sends a `link` notification (URL + optional message) to a user by email. |

The frontend wrapper is `@spelling-creator/core/notifications`.
