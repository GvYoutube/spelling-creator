// The seam between the host app's configuration and this package.
//
// Core modules must not read `import.meta.env` — that is Rsbuild-specific, it is
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
};

/**
 * Set the host's configuration. Call once, as early as possible. Merges, so a
 * later call can add a key without clearing the others.
 * @param {object} next
 * @param {string} [next.apiUrl] Base URL of the Worker API, trailing slash optional.
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
