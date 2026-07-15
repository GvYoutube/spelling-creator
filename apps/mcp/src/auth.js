// Token management.
//
// The Worker authenticates a publisher by verifying a Supabase session JWT
// (access token) sent as `Authorization: Bearer`. Those access tokens are
// short-lived (~1 hour), so a long-running MCP server can't just hold one. This
// module yields a *currently valid* access token on demand:
//
//   • If given a refresh token (env or session file), it trades it for a fresh
//     access token whenever the cached one is missing or about to expire, and
//     re-persists the rotated refresh token so the next start still works.
//   • If given only an access token, it uses it as-is and lets the API surface a
//     clear "please sign in again" error once it expires.
//
// No Supabase SDK — the two auth calls it needs are plain fetches, which keeps
// the package tiny and free of native deps.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Refresh a little before the token actually expires, to avoid a request racing
// the boundary.
export const EXPIRY_SKEW_SECONDS = 60;

// Decode a JWT's `exp` (seconds since epoch) without verifying the signature —
// we only need it to decide when to refresh, not to trust it.
export function jwtExpiry(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Trade a Supabase refresh token for a fresh session. Pure network call, no
 * mutable state — shared by the stdio auth provider (below), the remote
 * per-connection auth provider (worker.js), and the Worker's OAuth token
 * endpoint (apps/api), which all need the exact same GoTrue call.
 * @param {{ supabaseUrl: string, supabaseAnonKey: string }} config
 * @param {string} refreshToken
 */
export async function refreshSupabaseSession(config, refreshToken) {
  if (!refreshToken) {
    throw new Error("No Supabase refresh token to refresh with.");
  }
  const res = await fetch(
    `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Could not refresh the Supabase session (${res.status}). ` +
        "The refresh token may have been revoked — sign in again. " +
        (detail ? `Details: ${detail}` : ""),
    );
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Supabase did not return an access token.");
  }
  return {
    accessToken: data.access_token,
    // Supabase rotates the refresh token on every use; fall back to the one we
    // sent if the response omits it (shouldn't happen, but stay usable).
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: data.expires_at || null,
  };
}

async function readSessionFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeSessionFile(path, session) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(session, null, 2), { mode: 0o600 });
  } catch {
    // Persisting is best-effort: a read-only home dir just means we re-refresh
    // from the env-supplied token next start.
  }
}

/**
 * Build the auth provider.
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export function createAuth(config) {
  const envAccess = config.accessToken || "";
  const envRefresh = config.refreshToken || "";

  let accessToken = "";
  let refreshToken = "";
  // The env refresh token that "owns" the rotation chain persisted to the
  // session file. Supabase rotates the refresh token on every use, so the value
  // a bundle injects via env is only a *bootstrap seed*: after the first refresh
  // it's superseded by the rotated token in the file (and eventually revoked).
  // We tie the file's chain to its seed so a restart continues from the latest
  // rotated token, while a user pasting a *new* env token re-seeds a fresh chain.
  let seed = "";
  let hydrated = false;

  async function hydrate() {
    if (hydrated) return;
    hydrated = true;
    const file = await readSessionFile(config.sessionFile);

    if (envRefresh) {
      if (file && file.seed === envRefresh && file.refresh_token) {
        // Same seed → the file holds this chain's latest rotated token. Use it.
        accessToken = file.access_token || "";
        refreshToken = file.refresh_token;
      } else {
        // No file, or it belongs to a different (old) seed the user replaced.
        accessToken = envAccess;
        refreshToken = envRefresh;
      }
      seed = envRefresh;
      return;
    }

    if (envAccess) {
      // A bare access token: no refresh chain to maintain.
      accessToken = envAccess;
      return;
    }

    // No env credentials — fall back entirely to a login-helper session file.
    if (file && file.refresh_token) {
      accessToken = file.access_token || "";
      refreshToken = file.refresh_token;
      seed = file.seed || "";
    }
  }

  async function refresh() {
    if (!refreshToken) {
      throw new Error(
        "Your access token has expired and no refresh token is configured. " +
          "Run `pnpm --filter @spelling-creator/mcp login` (or set SUPABASE_REFRESH_TOKEN) to sign in again.",
      );
    }
    let session;
    try {
      session = await refreshSupabaseSession(config, refreshToken);
    } catch (err) {
      throw new Error(
        `${err.message} Sign in again with the \`login\` helper.`,
        {
          cause: err,
        },
      );
    }
    accessToken = session.accessToken;
    refreshToken = session.refreshToken;
    await writeSessionFile(config.sessionFile, {
      // Tie this rotation chain to its bootstrap seed (see `seed` above) so the
      // next start knows the file supersedes the now-stale env token.
      seed: seed || null,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: session.expiresAt,
      updated_at: new Date().toISOString(),
    });
    return accessToken;
  }

  /**
   * Return a valid access token, refreshing if we can and need to.
   */
  async function getAccessToken() {
    await hydrate();

    if (!accessToken && !refreshToken) {
      throw new Error(
        "No Supabase credentials configured. Set SUPABASE_REFRESH_TOKEN or " +
          "SUPABASE_ACCESS_TOKEN, or run the `login` helper. See apps/mcp/README.md.",
      );
    }

    const exp = accessToken ? jwtExpiry(accessToken) : null;
    const expired =
      !accessToken ||
      (exp !== null && exp - EXPIRY_SKEW_SECONDS <= nowSeconds());

    if (expired && refreshToken) {
      return refresh();
    }
    return accessToken;
  }

  /**
   * Force a refresh after the API rejects a token mid-flight (clock skew, an
   * unexpected revocation). Returns null when we can't (no refresh token), so
   * the caller can surface the original 401.
   */
  async function forceRefresh() {
    await hydrate();
    if (!refreshToken) return null;
    return refresh();
  }

  return { getAccessToken, forceRefresh };
}
