// Supabase client — used in the browser for authentication ONLY (magic-link
// sign-in). Lesson data never goes through this client; it is read from and
// written to the companion Worker (`apps/api`; see lib/lessons.js),
// which talks to Supabase Postgres server-side with privileged credentials.
//
// The client manages the signed-in session (persisting it in localStorage) and
// hands us a short-lived JWT that the Worker verifies before accepting a
// publish. We use the PKCE flow so the magic-link callback returns a `?code=`
// in the query string rather than access tokens in the URL fragment (hash).

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

// The localStorage key Supabase persists the session under. We don't pass a
// `storageKey` above, so the SDK computes its own default — this mirrors that
// formula (`sb-<project-ref>-auth-token`) so `readPersistedRefreshToken`
// below can read the same entry. See its comment for why that's needed.
const STORAGE_KEY = supabaseEnabled
  ? `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`
  : null;

/**
 * The refresh token from the session Supabase has persisted to localStorage,
 * read directly rather than through the SDK.
 *
 * This exists to recover from a real gap in @supabase/supabase-js's own
 * startup recovery: if the persisted access token is expired when the page
 * loads, the SDK tries to refresh it once as part of initializing; if that
 * attempt fails with a *retryable* error (e.g. a network hiccup right after
 * the page loads, before the connection is warm), it gives up silently —
 * the session is never loaded into the running client, but it's also not
 * cleared from storage, and nothing later retries (the auto-refresh timer
 * only ever acts on a session it already has in memory). The user looks
 * signed out, indefinitely, despite a perfectly valid session sitting on
 * disk — until the next full page load gets a working attempt. `auth.jsx`
 * uses this to force one more explicit refresh on mount when `getSession()`
 * comes back empty, rather than trusting that single internal attempt.
 *
 * Returns null (a safe no-op for the caller) if anything about this doesn't
 * parse as expected — including if the SDK ever changes its key format,
 * since this deliberately duplicates that private detail rather than
 * depending on it.
 */
export function readPersistedRefreshToken() {
  if (!STORAGE_KEY || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && parsed.refresh_token) || null;
  } catch {
    return null;
  }
}
