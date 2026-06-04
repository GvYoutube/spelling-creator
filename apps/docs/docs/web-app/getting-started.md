---
title: Getting started
sidebar_position: 10
---

# Getting started

```bash
pnpm install
pnpm dev      # start the dev server (http://localhost:5173)
pnpm build    # production build into dist/
pnpm preview  # preview the production build
```

## Environment variables

The AI text feature needs two variables in a `.env` file at the project root
(Vite exposes `VITE_`-prefixed vars to the client):

```bash
VITE_API_URL=https://your-worker.example.workers.dev   # spelling-creator-cf endpoint (AI, Pixabay, lesson hub)
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
