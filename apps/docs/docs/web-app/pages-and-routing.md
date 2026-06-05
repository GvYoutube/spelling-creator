---
title: Pages & routing
sidebar_position: 2
---

# Pages & routing

The app is a single-page app with real-path client-side routes (served by
`BrowserRouter`, not hash routes). Every page has a genuine URL like `/hub/:id`,
so the Worker can return a prerendered snapshot to crawlers and serves
`index.html` for unknown paths so deep links resolve:

| Route         | Page             | What it does                                                                                               |
| ------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `/`           | **Editor**       | The lesson builder (the original app). The "Save to cloud" dropdown (publish or save as draft) lives here. |
| `/hub`        | **Lesson hub**   | Public gallery of published lessons (plus your own drafts), with search.                                   |
| `/hub/:id`    | **Lesson page**  | A single published lesson's page: preview, comments, and author link.                                      |
| `/users/:id`  | **User profile** | A user's public profile — their bio and published lessons.                                                 |
| `/login`      | **Sign in**      | Magic-link sign-in / account status.                                                                       |
| `/moderation` | **Moderation**   | Moderator/admin queue for reviewing reported content (gated to mods/admins).                               |

Unknown paths redirect to the editor (`/`).

Every page's header carries a shared nav (a **Lesson hub** link and an account
control that shows **Sign in** or the signed-in account menu). Routing is set up
in `src/main.jsx` (`BrowserRouter` + `AuthProvider`, wrapped in a
`DisplayNameGate`) and the route table is in `src/App.jsx`.
