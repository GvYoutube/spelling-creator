// The seam between the host app's configuration and this package.
//
// Core modules must not read `import.meta.env` — that is bundler-specific, it is
// substituted at build time, and it does not exist in Node, in the Worker, or in
// another bundler's build. A module that reads it at import time can only ever be
// used by the web app, which is what previously pinned the whole image/export
// tier inside apps/web.
//
// So the host tells core what it needs to know, once, before anything uses it:
//
//   // apps/web/src/main.jsx
//   configureCore({ apiUrl: import.meta.env.VITE_API_URL });
//
// A SvelteKit app would pass `PUBLIC_API_URL` here instead, and the Worker or a
// test can pass whatever it likes. The reader functions resolve lazily, so import
// order doesn't matter — only that configureCore runs before the first *call*.

const config = {
  apiUrl: "",
  supabaseUrl: "",
  supabaseAnonKey: "",
  googleClientId: "",
  turnstileSiteKey: "",
  authMode: "magic-link",
};

/**
 * Set the host's configuration. Call once, as early as possible. Merges, so a
 * later call can add a key without clearing the others.
 * @param {object} next
 * @param {string} [next.apiUrl]           Base URL of the Worker API, trailing slash optional.
 * @param {string} [next.supabaseUrl]      Supabase project URL (browser auth only).
 * @param {string} [next.supabaseAnonKey]  Supabase anon key.
 * @param {string} [next.googleClientId]   OAuth 2.0 Web client id, for "save to Google Docs".
 * @param {string} [next.turnstileSiteKey] Public Cloudflare Turnstile site key.
 * @param {string} [next.authMode]         'magic-link' (default), 'password', or 'both'.
 */
export function configureCore(next) {
  Object.assign(config, next);
}

/**
 * Base URL of the Worker API, with any trailing slash removed so callers can
 * append `/images/…` without doubling it.
 *
 * Returns "" when unconfigured rather than throwing: the app is expected to run
 * against no backend at all (the homepage's word animation and the offline
 * editor both degrade gracefully), and that was the behaviour when each module
 * read a possibly-undefined env var itself.
 *
 * @returns {string}
 */
export function apiUrl() {
  return (config.apiUrl || "").replace(/\/$/, "");
}

/**
 * Whether a backend is configured at all. Callers that cannot degrade use this
 * to fail early with a clear message instead of fetching from "/…".
 * @returns {boolean}
 */
export function hasApi() {
  return apiUrl() !== "";
}

/**
 * Supabase's browser credentials, or null when auth isn't configured. Returned
 * together because neither half is usable alone.
 * @returns {{url: string, anonKey: string} | null}
 */
export function supabaseConfig() {
  const { supabaseUrl, supabaseAnonKey } = config;
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return { url: supabaseUrl, anonKey: supabaseAnonKey };
}

/**
 * Whether sign-in is available. When false the login page and "Publish to hub"
 * explain that accounts are unavailable, but browsing the hub still works.
 * @returns {boolean}
 */
export function hasSupabase() {
  return supabaseConfig() !== null;
}

/**
 * OAuth 2.0 Web client id for the Google Docs export. "" when unconfigured.
 * @returns {string}
 */
export function googleClientId() {
  return config.googleClientId || "";
}

/** @returns {boolean} Whether "save to Google Docs" is available. */
export function hasGoogleDrive() {
  return googleClientId() !== "";
}

/**
 * Public Turnstile site key for rendering the widget. "" when unconfigured, in
 * which case the AI and image-search dialogs explain they're unavailable.
 * @returns {string}
 */
export function turnstileSiteKey() {
  return config.turnstileSiteKey || "";
}

/** @returns {boolean} Whether the Turnstile-gated features are available. */
export function hasTurnstile() {
  return turnstileSiteKey() !== "";
}

/**
 * How people sign in to this instance.
 *
 * The hosted instance is magic-link only, which is the nicer experience and the
 * default. It is also the one that cannot work without a mail server — and a
 * self-hosted instance frequently has no SMTP at all, which would otherwise
 * leave it with no way for anyone to sign in. So the mode is per-instance:
 *
 *   'magic-link'  email a one-time link. Needs SMTP.
 *   'password'    email and password. Needs no mail at all.
 *   'both'        offer either, the visitor chooses.
 *
 * Anything unrecognised reads as 'magic-link', so a typo degrades to the
 * default rather than to an instance nobody can get into.
 *
 * @returns {'magic-link' | 'password' | 'both'}
 */
export function authMode() {
  const mode = (config.authMode || "").trim();
  return mode === "password" || mode === "both" ? mode : "magic-link";
}

/** @returns {boolean} Whether this instance offers email + password sign-in. */
export function hasPasswordAuth() {
  return authMode() !== "magic-link";
}

/** @returns {boolean} Whether this instance offers magic-link sign-in. */
export function hasMagicLinkAuth() {
  return authMode() !== "password";
}

/**
 * The shortest password this instance accepts.
 *
 * Matched to GOTRUE_PASSWORD_MIN_LENGTH on the server: the check here exists so
 * somebody is told before they submit, not instead of the server's.
 */
export const PASSWORD_MIN_LENGTH = 8;
