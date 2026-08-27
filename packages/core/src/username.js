// Usernames — the login identifier for an instance with no mail server.
//
// The identity service authenticates by email address and has no notion of a
// username, so one is given to it as an address it will never send to: the
// username becomes the local part of a synthetic address under a domain that
// cannot receive mail. That buys two things for nothing. Uniqueness is already
// enforced, because the service will not register the same address twice. And
// signing in needs no lookup — the client builds the same address from what was
// typed, rather than asking a server "which email does this username belong
// to?", which is a question no public endpoint should answer.
//
// The domain defaults to a `.invalid` one, reserved by RFC 2606 precisely so it
// can never resolve. A typo that sends mail somewhere real is then not a class
// of mistake that exists here.
//
// A username is NOT a display name. Display names are moderated, may contain
// spaces, and are deliberately not unique — two people may both be "Miss Kelly".
// A username is unique, never shown to anybody else, and exists only to sign in
// with. Registration therefore does not set a display name from it: that would
// route around the profanity and banned-name checks the profile endpoint
// applies, which is the whole reason those live on the server.

/** The domain used when an instance configures none. Reserved; cannot resolve. */
export const DEFAULT_USERNAME_DOMAIN = "users.noreply.invalid";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/**
 * Letters, digits, and the three separators an email local part accepts without
 * quoting — kept deliberately narrower than what an address technically allows,
 * because every one of these ends up in one. Must begin and end with a letter or
 * digit, so a name cannot be `.`, `-`, or anything that reads as punctuation.
 */
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

// Matching the app's existing check (see the login page); enough to tell an
// address from a username, which is all it is used for.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether this is an email address rather than a username. */
export function isEmailAddress(value) {
  return EMAIL_RE.test(String(value || "").trim());
}

/**
 * The canonical form of a username: trimmed and lower-cased.
 *
 * Case-folded because it becomes an email local part, and somebody who
 * registered as `Oliver` will later type `oliver` and expect to get in.
 */
export function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/** Whether `value` is usable as a username, once normalized. */
export function isUsername(value) {
  const name = normalizeUsername(value);
  return (
    name.length >= USERNAME_MIN_LENGTH &&
    name.length <= USERNAME_MAX_LENGTH &&
    USERNAME_RE.test(name)
  );
}

/**
 * The address a username signs in as.
 *
 * @param {string} username
 * @param {string} [domain]
 * @returns {string}
 */
export function usernameToEmail(username, domain = DEFAULT_USERNAME_DOMAIN) {
  return `${normalizeUsername(username)}@${String(
    domain || DEFAULT_USERNAME_DOMAIN,
  )
    .trim()
    .toLowerCase()}`;
}

/**
 * The username behind a synthetic address, or '' if the address is a real one.
 *
 * Used to show somebody their username rather than the address it was turned
 * into, which is an implementation detail they never chose and should not have
 * to look at.
 */
export function usernameFromEmail(email, domain = DEFAULT_USERNAME_DOMAIN) {
  const suffix = `@${String(domain || DEFAULT_USERNAME_DOMAIN)
    .trim()
    .toLowerCase()}`;
  const value = String(email || "")
    .trim()
    .toLowerCase();
  if (!value.endsWith(suffix)) return "";
  const name = value.slice(0, -suffix.length);
  return isUsername(name) ? name : "";
}

/**
 * Turn whatever somebody typed into the address to authenticate with.
 *
 * An input containing `@` is taken as an address and passed through, which is
 * what makes "either" work on an instance that also has real email accounts: the
 * same field accepts both, and which one it is is decided by the value rather
 * than by a toggle the person has to find.
 *
 * @returns {{ email: string, kind: 'email' | 'username' } | null} null when it is neither.
 */
export function identifierToEmail(input, domain = DEFAULT_USERNAME_DOMAIN) {
  const value = String(input || "").trim();
  if (value.includes("@")) {
    return isEmailAddress(value)
      ? { email: value.toLowerCase(), kind: "email" }
      : null;
  }
  return isUsername(value)
    ? { email: usernameToEmail(value, domain), kind: "username" }
    : null;
}
