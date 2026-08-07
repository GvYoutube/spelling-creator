---
title: Pages & routing
sidebar_position: 2
---

# Pages & routing

The app is a single-page app with real-path client-side routes (served by
`BrowserRouter`, not hash routes). Every page has a genuine URL like `/hub/:id`,
so the Worker can return a prerendered snapshot to crawlers and serves
`index.html` for unknown paths so deep links resolve:

| Route         | Page             | What it does                                                                                                                                                                                          |
| ------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`           | **Home**         | Landing page. Signed out: a marketing splash (animated floating words + feature blurbs). Signed in: a dashboard (latest-lessons feed, your activity, activity from people you follow, notifications). |
| `/editor`     | **Editor**       | The lesson builder (the original app). The "Save to cloud" dropdown (publish or save as draft) lives here.                                                                                            |
| `/hub`        | **Lesson hub**   | Public gallery of published lessons (plus your own drafts), with search.                                                                                                                              |
| `/hub/:id`    | **Lesson page**  | A single published lesson's page: preview, an optional [on-device AI summary](./lesson-summaries.md), comments, and author link.                                                                      |
| `/users/:id`  | **User profile** | A user's public profile — their bio, follower/following counts, a Follow button, and published lessons.                                                                                               |
| `/login`      | **Sign in**      | Magic-link sign-in / account status.                                                                                                                                                                  |
| `/moderation` | **Moderation**   | Moderator/admin queue for reviewing reported content (gated to mods/admins).                                                                                                                          |

Unknown paths redirect to the home page (`/`).

Once the PWA service worker is installed it resolves these routes itself, from
the precached `index.html`, which is what lets a deep link open with no network.
The paths the Worker answers instead — `/docs`, `/images/…`, the SEO and MCP
OAuth endpoints — are excluded by name; see
[Installable app & offline use](./pwa-and-offline.md#navigation-fallback-and-the-paths-it-must-not-touch).

Every page's header carries a shared nav (a **Lesson hub** link, an **install
app** button when the app is installable, and an account control that shows
**Sign in** or the signed-in account menu). Routing is set up in `src/main.jsx`
(`BrowserRouter` + `AuthProvider`, wrapped in a `DisplayNameGate`) and the route
table is in `src/App.jsx`.

## Home page

The home page (`src/pages/HomePage.jsx`) has two faces, chosen from the auth state:

- **Signed out** — a hero whose backdrop is real spelling words drifting upward
  (built with [tsParticles](https://particles.js.org); see
  `src/components/FloatingWords.jsx`), followed by alternating feature blurbs.
  The words come from the Worker's `GET /spelling-words.json` — an aggregate of
  every spelling word taught across the published hub lessons, rebuilt at most
  once every two days and cached in KV (`apps/api/src/routes/spelling-words.js`).
  A spelling row can hold a phrase rather than a single word ("ice cream"), and
  those animate badly — the shape scales text by character count, so a phrase
  renders tiny and stretched — so `@spelling-creator/core/spellingWords` drops any entry
  containing whitespace and only single words reach the animation.
  If that fetch fails, a small built-in word list is used instead. Feature
  illustrations live under `apps/web/public/home/` (a missing file degrades to a
  labelled placeholder — see that folder's `README.md`).
- **Signed in** — a dashboard showing the hub's latest-lessons Atom feed and the
  user's own activity feed (both parsed client-side from Atom with `DOMParser`,
  reusing the same `feed.xml` / `profiles/:id/feed.xml` endpoints the "RSS"
  links point at), a **"From people you follow"** feed (from the Worker's
  `GET /following/activity`; see [Following](./profiles-and-display-names.md#following)),
  plus a roomier list of the user's notifications.
