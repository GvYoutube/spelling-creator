// Load the git engine on demand.
//
// isomorphic-git + LightningFS are only needed once someone is actually editing a
// lesson, so they're split into their own chunk (engine.js) and fetched when the
// editor mounts — keeping them out of the bundle every homepage and hub visitor
// downloads.
//
// The import promise is memoised, so the chunk is fetched once however many
// callers ask for it.

let enginePromise = null;

/**
 * The git engine's module namespace. Awaiting this the first time fetches the
 * chunk; afterwards it resolves immediately.
 * @returns {Promise<typeof import("./engine.js")>}
 */
export function loadGitEngine() {
  if (!enginePromise) enginePromise = import("./engine.js");
  return enginePromise;
}
