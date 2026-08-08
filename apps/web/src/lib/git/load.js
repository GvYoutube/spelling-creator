// Load the git engine on demand.
//
// isomorphic-git + LightningFS are only needed once someone is actually editing a
// lesson, so they're split into their own chunk (engine.js) and fetched when the
// editor mounts — keeping them out of the bundle every homepage and hub visitor
// downloads.
//
// The import promise is memoised, so the chunk is fetched once however many
// callers ask for it — but only a *successful* one is kept. Caching a rejected
// promise would mean one flaky network moment permanently disables version
// history for the rest of the session. (Same rule as lib/exports/load.js.)

let enginePromise = null;

/**
 * The git engine's module namespace. Awaiting this the first time fetches the
 * chunk; afterwards it resolves immediately. A failed load is not remembered, so
 * the next caller retries.
 * @returns {Promise<typeof import("./engine.js")>}
 */
export function loadGitEngine() {
  if (!enginePromise) {
    enginePromise = import("./engine.js").catch((err) => {
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}
