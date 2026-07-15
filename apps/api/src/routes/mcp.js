// Remote MCP endpoint — mounts the Spelling Creator MCP tools (from
// @spelling-creator/mcp) as a Streamable HTTP server, gated by a real OAuth 2.1
// flow instead of a pasted token. See routes/oauth.js for the consent screen
// that grants access, and buildOAuthProvider (called from index.js) for how the
// two are wired together.
//
// Supabase is the upstream identity: each grant's `props` carries a Supabase
// session captured at consent time (see routes/oauth.js), which `tokenExchangeCallback`
// below rotates in step with the MCP client's own OAuth token refresh — so
// `this.props.supabaseAccessToken` is normally already fresh by the time a tool
// call needs it, with no extra network round trip. `grantAuth` (in
// @spelling-creator/mcp/worker) is the defense-in-depth fallback for a
// connection that outlives that cadence.

import { OAuthProvider, GrantType } from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import { buildMcpServer, grantAuth } from '@spelling-creator/mcp/worker';
import { refreshSupabaseSession } from '@spelling-creator/mcp/auth';
import { handleAuthorize, handleOAuthRequest, handleOAuthApprove } from './oauth.js';

// Our own MCP access tokens live noticeably shorter than a Supabase JWT's ~1h
// lifetime, so a client that respects `expires_in` refreshes — and so rotates
// the upstream Supabase session, below — before that JWT would go stale.
const MCP_ACCESS_TOKEN_TTL = 45 * 60;

export function mcpConfig(env) {
	return {
		apiUrl: env.SPELLING_CREATOR_API_URL || 'https://spellingcreator.org',
		supabaseUrl: env.SUPABASE_URL,
		supabaseAnonKey: env.SUPABASE_ANON_KEY,
	};
}

export class HubMcp extends McpAgent {
	async init() {
		const config = mcpConfig(this.env);
		this.server = buildMcpServer(config, grantAuth(config, this.props));
	}
}

// Register the consent-flow endpoints on the app that serves everything else —
// they're ordinary routes, just ones that happen to call the env.OAUTH_PROVIDER
// helpers the library injects (see routes/oauth.js). Called once at module init
// since the routes themselves are static; only the OAuthProvider wrapping the
// whole app is built per request (below), so its callbacks can close over env.
export function registerOAuthConsentRoutes(app) {
	app.get('/authorize', (c) => handleAuthorize(c.req.raw, c.env));
	app.get('/oauth/request', (c) => handleOAuthRequest(c.req.raw, c.env, new URL(c.req.url), c.get('cors')));
	app.post('/oauth/approve', (c) => handleOAuthApprove(c.req.raw, c.env, new URL(c.req.url), c.get('cors')));
}

/**
 * Wraps the existing Hono `app` (unchanged for every other route) with the
 * OAuth authorization server + the `/mcp` Streamable HTTP endpoint. Built fresh
 * per request — cheap (just wiring config/closures, no I/O) — so
 * `tokenExchangeCallback` can close over this request's real `env` bindings
 * instead of hardcoding the Supabase project.
 * @param {import('hono').Hono} app
 * @param {*} env
 */
export function buildOAuthProvider(app, env) {
	const config = mcpConfig(env);
	return new OAuthProvider({
		apiRoute: '/mcp',
		apiHandler: HubMcp.serve('/mcp'),
		defaultHandler: app,
		authorizeEndpoint: '/authorize',
		tokenEndpoint: '/token',
		clientRegistrationEndpoint: '/register',
		scopesSupported: ['lessons'],
		accessTokenTTL: MCP_ACCESS_TOKEN_TTL,
		async tokenExchangeCallback(options) {
			if (options.grantType !== GrantType.REFRESH_TOKEN) {
				return { accessTokenTTL: MCP_ACCESS_TOKEN_TTL };
			}
			// Rides along with the MCP client's own refresh cadence: mint a fresh
			// Supabase session now, so tool calls over the next ~45 minutes' worth
			// of connections don't each need their own refresh round trip.
			const session = await refreshSupabaseSession(config, options.props.supabaseRefreshToken);
			return {
				newProps: {
					...options.props,
					supabaseAccessToken: session.accessToken,
					supabaseRefreshToken: session.refreshToken,
				},
				accessTokenTTL: MCP_ACCESS_TOKEN_TTL,
			};
		},
	});
}
