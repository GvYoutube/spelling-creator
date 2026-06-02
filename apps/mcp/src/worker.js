// Remote-transport scaffold.
//
// The tool layer (tools.js) and API client (api.js) are transport-agnostic, so
// the same lessons-publishing surface can run remotely — mounted as a route on
// the existing Cloudflare Worker (apps/api) so any MCP client can connect over
// HTTP, e.g. claude.ai. This module supplies the two remote-specific pieces:
//
//   1. `staticTokenAuth` — remote callers send their own Supabase access token
//      per request (in the Authorization header), so there's no refresh loop;
//      the auth shim just yields that token. It satisfies the same interface
//      api.js expects, so the whole client works unchanged.
//   2. `buildMcpServer` — construct a fully-wired McpServer for one request.
//
// What's intentionally left to the host Worker (a small, separate change in
// apps/api/src/index.js): bridging an HTTP request to an MCP transport. On
// Cloudflare the clean path is the Agents SDK `McpAgent` (the `agents` package),
// whose `serve()/serveSSE()` handle the Streamable-HTTP/SSE protocol and session
// lifecycle that the base SDK's Node transport can't on the edge. Wiring sketch:
//
//   import { McpAgent } from "agents/mcp";
//   import { buildMcpServer, staticTokenAuth } from "@spelling-creator/mcp/worker";
//   export class HubMcp extends McpAgent {
//     async init() {
//       const token = bearerFrom(this.props.request);          // per-connection
//       this.server = buildMcpServer({ apiUrl, supabaseUrl, supabaseAnonKey }, token);
//     }
//   }
//   // then in the Worker's fetch(): if (path === "/mcp") return HubMcp.serve("/mcp").fetch(...)
//
// Until that route is added, the local stdio server (stdio.js) is the supported
// way to connect an assistant.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createApi } from "./api.js";
import { registerTools, SERVER_INFO } from "./tools.js";

/**
 * Auth shim for a remote, per-request token. No refresh: the client is expected
 * to present a currently-valid Supabase access token on each call.
 * @param {string} token
 */
export function staticTokenAuth(token) {
  return {
    async getAccessToken() {
      if (!token) {
        throw new Error(
          "Missing Supabase access token. Send it as `Authorization: Bearer <token>`.",
        );
      }
      return token;
    },
    // Nothing to refresh remotely — surface the 401 so the client re-authenticates.
    async forceRefresh() {
      return null;
    },
  };
}

/**
 * Build a request-scoped MCP server bound to one caller's token.
 * @param {{ apiUrl: string, supabaseUrl: string, supabaseAnonKey: string }} config
 * @param {string} token  The caller's Supabase access token.
 */
export function buildMcpServer(config, token) {
  const auth = staticTokenAuth(token);
  const api = createApi(config, auth);
  const server = new McpServer(SERVER_INFO);
  registerTools(server, { api, config });
  return server;
}
