---
title: Notifications
sidebar_position: 11
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
  posted (notifying the parent comment's author and the lesson's author).
- **`link`** — another signed-in user sent you a link via **send link to user**
  (an optional short message can ride along, and is profanity-checked server-side).
  Because the recipient may not have an account id yet, a `link` notification is
  addressed by **email**, so it's waiting for them the next time they sign in.

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

The frontend wrapper is `src/lib/notifications.js`.
