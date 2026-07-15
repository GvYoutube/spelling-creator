// Remote-transport pieces.
//
// The tool layer (tools.js) and API client (api.js) are transport-agnostic, so
// the same lessons-publishing surface also runs remotely, mounted as an MCP
// OAuth route on the existing Cloudflare Worker (apps/api) so any MCP client can
// connect over HTTP with a real "Connect" flow — no token ever pasted by hand.
// See apps/api/src/routes/mcp.js for the Worker-side wiring (the `HubMcp`
// McpAgent + OAuthProvider) and apps/api/src/routes/oauth.js for the consent
// flow that backs it. This module supplies the two remote-specific pieces:
//
//   1. `grantAuth` — the OAuth grant's `props` (captured once, at consent time)
//      carry a Supabase refresh token for the connection's lifetime. This wraps
//      that in the same getAccessToken()/forceRefresh() shape api.js expects,
//      so the whole client works unchanged. It's a defense-in-depth fallback:
//      the primary refresh path is apps/api's `tokenExchangeCallback`, which
//      rotates the Supabase session in step with the MCP client's own OAuth
//      token refresh and keeps `props.supabaseAccessToken` fresh; this only
//      does a live network refresh if that cached access token has gone stale
//      mid-session.
//   2. `buildMcpServer` — construct a fully-wired McpServer for one connection,
//      given any auth provider (this one, or the stdio one from auth.js).
//
// Local stdio (stdio.js) remains the CLI-first path for users who'd rather run
// the server themselves; this is the additive one-click path for remote clients
// like claude.ai, Claude Desktop, and Cursor.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createApi } from "./api.js";
import { registerTools, SERVER_INFO } from "./tools.js";
import {
  EXPIRY_SKEW_SECONDS,
  jwtExpiry,
  nowSeconds,
  refreshSupabaseSession,
} from "./auth.js";

/**
 * Auth provider seeded from an OAuth grant's `props` (see apps/api/src/routes/mcp.js).
 * Holds tokens in memory only, for this connection's lifetime — the durable
 * copy lives in the grant's encrypted props, rotated by `tokenExchangeCallback`.
 * @param {{ supabaseUrl: string, supabaseAnonKey: string }} config
 * @param {{ supabaseAccessToken?: string, supabaseRefreshToken?: string }} props
 */
export function grantAuth(config, props) {
  let accessToken = props?.supabaseAccessToken || "";
  let refreshToken = props?.supabaseRefreshToken || "";

  async function refresh() {
    if (!refreshToken) {
      throw new Error(
        "This connection's Supabase session is missing. Reconnect and approve access again.",
      );
    }
    const session = await refreshSupabaseSession(config, refreshToken);
    accessToken = session.accessToken;
    refreshToken = session.refreshToken;
    return accessToken;
  }

  async function getAccessToken() {
    if (!accessToken && !refreshToken) {
      throw new Error(
        "No Supabase session on this connection. Reconnect and approve access again.",
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

  async function forceRefresh() {
    if (!refreshToken) return null;
    return refresh();
  }

  return { getAccessToken, forceRefresh };
}

/**
 * Build a connection-scoped MCP server bound to an auth provider (either
 * `grantAuth` above, for remote, or `createAuth` from auth.js, for stdio).
 * @param {{ apiUrl: string, supabaseUrl: string, supabaseAnonKey: string }} config
 * @param {{ getAccessToken: Function, forceRefresh: Function }} auth
 */
export function buildMcpServer(config, auth) {
  const api = createApi(config, auth);
  const server = new McpServer(SERVER_INFO);
  registerTools(server, { api, config });
  return server;
}
