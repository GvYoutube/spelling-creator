// The names a lesson's branches may have, and how a branch's name relates to the
// words a person actually typed.
//
// Deliberately free of any git dependency, for the same reason doc.js and ops.js
// are: the Worker validates a push's ref map (apps/api/src/routes/git.js) and the
// editor validates a name before offering it, and neither should have to pull in
// isomorphic-git to do it. Both import this file, so the rules can't drift apart.
//
// ---- Two names for one thing ------------------------------------------------
//
// A branch has a *ref name*, which git stores and which git's own rules bound
// ("Simpler-for-Year-3"), and a *label*, which is what the person sees ("Simpler
// for Year 3"). We don't store the label anywhere: it is the ref name with its
// hyphens read back as spaces, which round-trips the case that matters — someone
// typing a short phrase — without inventing a second place for a name to live and
// go stale.

/** The branch a lesson is, as far as everyone but its author is concerned. */
export const DEFAULT_BRANCH = "main";

// Bounds, enforced on both sides of the push.
//
// The ceiling on the count is not arbitrary: a lesson's ref map rides in the R2
// object's customMetadata, alongside the pack it belongs to, so that a reader can
// never pair one lesson's bytes with another moment's refs. R2 caps that metadata
// at 2 KB in total, and MAX_BRANCHES * (MAX_BRANCH_NAME + an oid + JSON syntax)
// has to stay comfortably inside it. Twelve is far more variations than a lesson
// has any use for, and leaves room to spare.
export const MAX_BRANCHES = 12;
export const MAX_BRANCH_NAME = 32;

// Characters git allows that we also want: letters, digits, and the three
// separators. Everything else — spaces, slashes, and the punctuation git reserves
// for its own syntax — is either converted or dropped by toBranchName below.
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A 40-character lowercase hex SHA-1, as git writes them. */
export const OID_RE = /^[0-9a-f]{40}$/;

/**
 * Whether `name` is a branch name we will store.
 *
 * The two exclusions past the character set are git's own: `..` is how a revision
 * range is written, and a ref file may not end in `.lock`, which is the name git
 * gives its own lock files.
 */
export function isBranchName(name) {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > MAX_BRANCH_NAME) return false;
  if (!BRANCH_NAME_RE.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.endsWith(".lock")) return false;
  return true;
}

/**
 * The branch name for something a person typed.
 *
 * Spaces become hyphens (so branchLabel can turn them back), anything git would
 * refuse is dropped, and the result is trimmed to the length limit on a
 * separator where there is one nearby — cutting "Year-3" to "Year-" reads worse
 * than cutting it to "Year".
 *
 * @returns {string} A valid branch name, or "" when nothing usable was left.
 */
export function toBranchName(label) {
  let name = (label || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".");

  // Must start on a letter or digit: leading separators are git's own syntax.
  name = name.replace(/^[._-]+/, "");
  if (name.length > MAX_BRANCH_NAME) {
    const cut = name.slice(0, MAX_BRANCH_NAME);
    const sep = cut.lastIndexOf("-");
    name = sep > MAX_BRANCH_NAME * 0.6 ? cut.slice(0, sep) : cut;
  }
  name = name.replace(/[._-]+$/, "");

  if (name.endsWith(".lock")) name = name.slice(0, -5).replace(/[._-]+$/, "");
  return isBranchName(name) ? name : "";
}

/** What to show a person for a branch name. The inverse of toBranchName's spaces. */
export function branchLabel(name) {
  return (name || "").replace(/-/g, " ");
}

/**
 * Read a ref map off the wire — the `{ "<branch>": "<oid>" }` object a push
 * sends and a pack's metadata carries.
 *
 * Every part of it is checked, because both callers are reading something they
 * did not write: the Worker is reading a client's headers, and a client is
 * reading a response. An unparseable or over-long map is null rather than a
 * partial one, so a caller can't half-apply somebody's intent.
 *
 * @returns {object|null} The validated map, or null if it is not one.
 */
export function parseRefMap(json) {
  if (!json) return null;
  let value;
  try {
    value = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const names = Object.keys(value);
  if (names.length > MAX_BRANCHES) return null;

  const map = {};
  for (const name of names) {
    if (!isBranchName(name)) return null;
    const oid = value[name];
    // An empty string is meaningful in an *expected* map: "I believe this branch
    // does not exist yet". Callers that don't accept absence reject it themselves.
    if (oid === "") {
      map[name] = "";
      continue;
    }
    if (typeof oid !== "string" || !OID_RE.test(oid)) return null;
    map[name] = oid;
  }
  return map;
}

/** A ref map as it travels: compact JSON, keys sorted so it is stable to compare. */
export function serializeRefMap(map) {
  const out = {};
  for (const name of Object.keys(map || {}).sort()) out[name] = map[name];
  return JSON.stringify(out);
}
