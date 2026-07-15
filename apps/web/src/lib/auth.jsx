// Auth context — wraps the Supabase session so any page can read the current
// user, send a magic-link sign-in email, or sign out. Lesson reads/writes do
// NOT happen here; this only owns the session and the access token that the
// Worker needs to authorise a publish.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase, supabaseEnabled } from "./supabase.js";
import { fetchMyRole } from "./moderation.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  // The signed-in user's moderation tier ("admin" | "moderator" | null),
  // looked up from the Worker. Used only to decide which moderation controls to
  // render; every privileged action is independently authorised server-side.
  const [role, setRole] = useState(null);
  // True while the role for the current token is being fetched. Pages that gate
  // on the role (the moderation dashboard) wait for this so they don't flash a
  // "no access" state — or bounce the user — before the lookup has resolved.
  const [roleLoading, setRoleLoading] = useState(false);
  // `loading` is true until we know whether a session was restored from storage
  // (or parsed from a magic-link callback), so pages can avoid flashing a
  // signed-out state on first paint.
  const [loading, setLoading] = useState(supabaseEnabled);

  useEffect(() => {
    if (!supabaseEnabled) return;

    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  // Look up the signed-in user's moderation role whenever the token changes
  // (sign-in/out, refresh). Clears to null when signed out.
  const accessToken = session?.access_token ?? null;
  useEffect(() => {
    let active = true;
    if (!accessToken) {
      setRole(null);
      setRoleLoading(false);
      return;
    }
    setRoleLoading(true);
    fetchMyRole(accessToken).then((r) => {
      if (!active) return;
      setRole(r);
      setRoleLoading(false);
    });
    return () => {
      active = false;
    };
  }, [accessToken]);

  const user = session?.user ?? null;
  // The public name the user chose (set via the Worker's /profile endpoint and
  // stored in user_metadata). This — never the email — is what other users see.
  const displayName = (user?.user_metadata?.display_name || "").trim() || null;

  const value = useMemo(
    () => ({
      enabled: supabaseEnabled,
      loading,
      session,
      user,
      // The JWT the Worker verifies before accepting a publish.
      accessToken: session?.access_token ?? null,
      // The user's chosen display name, or null if they haven't set one yet.
      displayName,
      // True once we know a signed-in user still needs to pick a display name, so
      // the app can force the choice before letting them post. Waits for `loading`
      // so we don't flash the prompt before the session is restored.
      needsDisplayName: supabaseEnabled && !loading && !!user && !displayName,
      // Moderation tier (see `role` state above) plus convenience flags. A mod or
      // admin is a "moderator+"; only an admin is an "admin".
      role,
      roleLoading,
      isModerator: role === "moderator" || role === "admin",
      isAdmin: role === "admin",

      // Send a passwordless magic link. `redirectTo` brings the user back to
      // the given page (the app root by default), where the Supabase client
      // exchanges the `?code=` for a session. Callers that need the user back
      // on a specific page — e.g. the MCP OAuth consent screen, which carries
      // its own `?state=` — can pass an explicit redirectTo.
      async signInWithMagicLink(email, redirectTo = window.location.origin) {
        if (!supabaseEnabled) {
          throw new Error("Sign-in is not configured.");
        }
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo },
        });
        if (error) throw new Error(error.message);
      },

      async signOut() {
        if (!supabaseEnabled) return;
        await supabase.auth.signOut();
      },

      // Pull a fresh session from Supabase so newly-saved user_metadata (e.g. a
      // display name just written by the Worker via the Admin API) is reflected in
      // `user`. The Worker writes metadata out-of-band, so the cached session must
      // be refreshed for the change to show up client-side.
      async refreshSession() {
        if (!supabaseEnabled) return;
        const { data } = await supabase.auth.refreshSession();
        setSession(data?.session ?? null);
      },
    }),
    [loading, session, user, displayName, role, roleLoading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an <AuthProvider>.");
  }
  return ctx;
}
