// Load the document export/import pipeline on demand.
//
// Same shape as lib/git/load.js, and for the same reason: `docx`, `mammoth`,
// `html2pdf.js` and friends are only reachable from a click handler (Export,
// Preview, Import), so they belong in a chunk that the homepage, the hub and the
// public lesson page never fetch. See engine.js for what's in it.
//
// The import promise is memoised, so the chunk is fetched once however many
// callers ask for it.

let enginePromise = null;

/**
 * The export engine's module namespace. Awaiting this the first time fetches the
 * chunk; afterwards it resolves immediately.
 * @returns {Promise<typeof import("./engine.js")>}
 */
export function loadExportEngine() {
  if (!enginePromise) enginePromise = import("./engine.js");
  return enginePromise;
}
