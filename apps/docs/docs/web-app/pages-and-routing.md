---
title: Pages & routing
sidebar_position: 2
---

# Pages & routing

The app is a single-page app with three client-side routes (hash-based, so deep
links work on any static host without server rewrites):

| Route    | Page           | What it does                                                                                               |
| -------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `/`      | **Editor**     | The lesson builder (the original app). The "Save to cloud" dropdown (publish or save as draft) lives here. |
| `/hub`   | **Lesson hub** | Public gallery of published lessons (plus your own drafts); click one to preview it.                       |
| `/login` | **Sign in**    | Magic-link sign-in / account status.                                                                       |

Every page's header carries a shared nav (a **Lesson hub** link and an account
control that shows **Sign in** or the signed-in account menu). Routing is set up
in `src/main.jsx` (`HashRouter` + `AuthProvider`) and the route table is in
`src/App.jsx`.
