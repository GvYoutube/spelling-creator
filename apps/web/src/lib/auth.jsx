// Auth context — wraps the Supabase session so any page can read the current
// user, send a magic-link sign-in email, or sign out. Lesson reads/writes do
// NOT happen here; this only owns the session and the access token that the
// Worker needs to authorise a publish.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  hasMagicLinkAuth,
  hasPasswordAuth,
  hasSupabase,
  usernameDomain,
} from "@spelling-creator/core/config";
import {
  identifierToEmail,
  usernameFromEmail,
  usernameToEmail,
} from "@spelling-creator/core/username";
import {
  getSupabase,
  readPersistedRefreshToken,
} from "@spelling-creator/core/browser/supabase";
import { fetchMyRole } from "@spelling-creator/core/moderation";

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
  const [loading, setLoading] = useState(hasSupabase());

  useEffect(() => {
    if (!hasSupabase()) return;

    let active = true;
    getSupabase()
      .auth.getSession()
      .then(async ({ data }) => {
        if (!active) return;
        if (data.session) {
          setSession(data.session);
          setLoading(false);
          return;
        }
        // No session in memory — normally that just means signed out, but it's
        // also what a known SDK gap looks like: a valid session can be stuck
        // unloaded after a failed startup refresh (see readPersistedRefreshToken
        // for the full story). If a persisted refresh token is sitting in
        // storage, force one more real refresh attempt with it before
        // concluding the user is actually signed out.
        const refreshToken = readPersistedRefreshToken();
        if (!refreshToken) {
          setSession(null);
          setLoading(false);
          return;
        }
        const { data: refreshed } = await getSupabase()
          .auth.refreshSession({ refresh_token: refreshToken })
          .catch(() => ({ data: null }));
        if (!active) return;
        setSession(refreshed?.session ?? null);
        setLoading(false);
      });

    const {
      data: { subscription },
    } = getSupabase().auth.onAuthStateChange((_event, nextSession) => {
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
  // The login identifier for a username account, read from metadata and falling
  // back to unpicking the synthetic address — accounts made before the metadata
  // was written still have the username sitting in their address.
  const username =
    (user?.user_metadata?.username || "").trim() ||
    usernameFromEmail(user?.email, usernameDomain()) ||
    null;

  const value = useMemo(
    () => ({
      enabled: hasSupabase(),
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
      needsDisplayName: hasSupabase() && !loading && !!user && !displayName,
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
        if (!hasSupabase()) {
          throw new Error("Sign-in is not configured.");
        }
        const { error } = await getSupabase().auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectTo },
        });
        if (error) throw new Error(error.message);
      },

      // Whether this instance offers each way in. Both are read here rather than
      // by the login page so there is one answer to "how does one sign in".
      passwordAuth: hasPasswordAuth(),
      magicLinkAuth: hasMagicLinkAuth(),

      // The username this account signs in with, or null for one created from a
      // real email address. Never shown to anybody else — see
      // @spelling-creator/core/username for why it is not a display name.
      username,

      // Sign in with a password, by username or by email address.
      //
      // Which one was typed is decided by the value rather than by a toggle: an
      // input containing `@` is an address, anything else is a username, and a
      // username is turned into the synthetic address it registered under. That
      // is what makes one field accept either on an instance that has both.
      async signInWithPassword(identifier, password) {
        if (!hasSupabase()) throw new Error("Sign-in is not configured.");
        const resolved = identifierToEmail(identifier, usernameDomain());
        if (!resolved) throw new Error("Enter your username or email address.");
        const { error } = await getSupabase().auth.signInWithPassword({
          email: resolved.email,
          password,
        });
        if (error) throw new Error(error.message);
      },

      // Create an account from a username and a password, with no email address
      // involved at all — which is the point, on an instance with no mail.
      //
      // The username goes into user_metadata as well as into the address, so it
      // can be shown back to its owner without unpicking the address. It
      // deliberately does NOT set a display name: display names are checked for
      // profanity and banned names by the profile endpoint, and letting the
      // client set one at registration would route around that.
      //
      // Whether the new account can sign in immediately depends on the server.
      // With mail configured it will want the address confirmed first — which a
      // synthetic address can never be, so an instance offering usernames is
      // expected to auto-confirm. `needsConfirmation` reports which happened
      // rather than leaving the page to guess.
      async signUpWithUsername(username_, password) {
        if (!hasSupabase()) throw new Error("Sign-in is not configured.");
        const { data, error } = await getSupabase().auth.signUp({
          email: usernameToEmail(username_, usernameDomain()),
          password,
          options: { data: { username: username_.trim().toLowerCase() } },
        });
        if (error) throw new Error(error.message);
        return { needsConfirmation: !data?.session };
      },

      async signOut() {
        if (!hasSupabase()) return;
        await getSupabase().auth.signOut();
      },

      // Pull a fresh session from Supabase so newly-saved user_metadata (e.g. a
      // display name just written by the Worker via the Admin API) is reflected in
      // `user`. The Worker writes metadata out-of-band, so the cached session must
      // be refreshed for the change to show up client-side.
      async refreshSession() {
        if (!hasSupabase()) return;
        const { data } = await getSupabase().auth.refreshSession();
        setSession(data?.session ?? null);
      },
    }),
    [loading, session, user, displayName, username, role, roleLoading],
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
