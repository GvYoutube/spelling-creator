// Auth context — wraps the Supabase session so any page can read the current
// user, send a magic-link sign-in email, or sign out. Lesson reads/writes do
// NOT happen here; this only owns the session and the access token that the
// Worker needs to authorise a publish.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase, supabaseEnabled } from "./supabase.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
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

  const value = useMemo(
    () => ({
      enabled: supabaseEnabled,
      loading,
      session,
      user: session?.user ?? null,
      // The JWT the Worker verifies before accepting a publish.
      accessToken: session?.access_token ?? null,

      // Send a passwordless magic link. `redirectTo` brings the user back to the
      // app root, where the Supabase client exchanges the `?code=` for a session.
      async signInWithMagicLink(email) {
        if (!supabaseEnabled) {
          throw new Error("Sign-in is not configured.");
        }
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw new Error(error.message);
      },

      async signOut() {
        if (!supabaseEnabled) return;
        await supabase.auth.signOut();
      },
    }),
    [loading, session],
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
