---
title: Getting started
sidebar_position: 13
---

# Getting started

```bash
pnpm install
pnpm dev      # start the dev server (http://localhost:5173)
pnpm build    # production build into dist/
pnpm preview  # preview the production build
```

The PWA service worker is a production concern and is switched off under
`pnpm dev`, so HMR behaves normally; use `pnpm build && pnpm preview` to exercise
it (see [Installable app & offline use](./pwa-and-offline.md#local-development)).

## Environment variables

Optional features are configured in `apps/web/.env` — Vite reads env
files from the package holding `vite.config.js`, not from the monorepo root, and
exposes only `VITE_`-prefixed vars to client code:

```bash
VITE_API_URL=https://your-worker.example.workers.dev   # apps/api Worker endpoint (AI, Pixabay, lesson hub)
VITE_TURNSTILE_SITE_KEY=0x...                           # Cloudflare Turnstile site key
VITE_GOOGLE_CLIENT_ID=...apps.googleusercontent.com     # OAuth client for Save to Google Docs
VITE_SUPABASE_URL=https://xxxx.supabase.co              # Supabase project URL (magic-link sign-in)
VITE_SUPABASE_ANON_KEY=eyJ...                           # Supabase anon (public) key
```

The app degrades gracefully when a feature is unconfigured:

- Without `VITE_API_URL` / `VITE_TURNSTILE_SITE_KEY` the **AI text** dialog is
  disabled, and without `VITE_API_URL` the **Lesson hub** shows a "not
  configured" notice.
- Without `VITE_GOOGLE_CLIENT_ID` the **Save to Google Docs** button is hidden.
- Without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` sign-in is disabled
  (the login page explains this) and the **Save to cloud** button is hidden;
  browsing the hub still works.

The Supabase **anon key** is designed to be shipped to the browser. Keep the
**service-role key** and **JWT secret** on the Worker only — never in `VITE_*`
vars, which are bundled into the client.
