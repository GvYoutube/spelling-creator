// Profile API — talks to the same `spelling-creator-cf` Worker as the rest of the
// hub. The display name is the only identity shown to other users; we set it via
// the Worker (not supabase.auth.updateUser) so the name is validated server-side
// — length, profanity and name bans — before it is stored in user_metadata.
//
// Worker endpoints (see handleProfile in apps/api/src/index.js):
//   POST /profile/display-name   Bearer  { displayName }  -> { displayName }
//   POST /profile/bio            Bearer  { bio }          -> { bio }

const API_URL = import.meta.env.VITE_API_URL;

// Mirrors the Worker's bounds (DISPLAY_NAME_MIN / DISPLAY_NAME_MAX) so the form
// can validate before sending; the Worker re-checks regardless.
export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 40;

// Mirrors the Worker's BIO_MAX. An empty bio is allowed and clears it.
export const BIO_MAX = 500;

/**
 * Save the signed-in user's public display name. Resolves to the stored name on
 * success; throws an Error carrying the Worker's plain-text reason on failure.
 * @param {string} displayName The chosen name.
 * @param {string} accessToken Supabase session JWT.
 * @returns {Promise<string>}
 */
export async function setDisplayName(displayName, accessToken) {
  if (!API_URL) throw new Error("Accounts are not configured.");
  if (!accessToken) throw new Error("Please sign in.");
  let res;
  try {
    res = await fetch(`${API_URL.replace(/\/$/, "")}/profile/display-name`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName }),
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status}).`);
  }
  const data = await res.json().catch(() => ({}));
  return data.displayName || displayName;
}

/**
 * Save (or clear) the signed-in user's public bio. Pass an empty string to clear
 * it. Resolves to the stored bio on success; throws an Error carrying the Worker's
 * plain-text reason on failure (e.g. profanity or over the length limit).
 * @param {string} bio          The bio text (≤ BIO_MAX chars; "" clears it).
 * @param {string} accessToken  Supabase session JWT.
 * @returns {Promise<string>}
 */
export async function setBio(bio, accessToken) {
  if (!API_URL) throw new Error("Accounts are not configured.");
  if (!accessToken) throw new Error("Please sign in.");
  let res;
  try {
    res = await fetch(`${API_URL.replace(/\/$/, "")}/profile/bio`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bio }),
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status}).`);
  }
  const data = await res.json().catch(() => ({}));
  return typeof data.bio === "string" ? data.bio : bio;
}
