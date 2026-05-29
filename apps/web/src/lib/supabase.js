// Supabase client — used in the browser for authentication ONLY (magic-link
// sign-in). Lesson data never goes through this client; it is read from and
// written to the companion `spelling-creator-cf` Worker (see lib/lessons.js),
// which talks to Supabase Postgres server-side with privileged credentials.
//
// The client manages the signed-in session (persisting it in localStorage) and
// hands us a short-lived JWT that the Worker verifies before accepting a
// publish. We use the PKCE flow so the magic-link callback returns a `?code=`
// in the query string rather than tokens in the URL hash, which keeps it from
// colliding with the HashRouter routes.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Whether auth is configured at build time. When false the login page and the
// "Publish to hub" action explain that sign-in is unavailable, but browsing the
// hub (a public, unauthenticated read) still works.
export const supabaseEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
