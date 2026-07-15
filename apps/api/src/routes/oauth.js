// Consent flow backing the remote MCP OAuth route (see routes/mcp.js for the
// OAuthProvider wiring). Unlike a typical "redirect out to a third-party IdP"
// OAuth flow, Supabase is *our own* identity provider and the connecting
// browser is very likely already signed into the web app — so the consent
// screen is just an ordinary page of the SPA (served by the frontend
// fall-through at GET /oauth/authorize) making a same-origin, bearer-token API
// call, not a cross-site redirect dance. No CSRF cookies needed: `state` here
// only correlates the initial /authorize GET (from the MCP client) with the
// later /oauth/approve POST (from our signed-in user), via a short-lived,
// single-use KV entry — the same pattern Cloudflare's own OAuth demos use.

import { verifySupabaseUser } from '../lib/supabase.js';
import { bearerToken, displayNameOf } from '../lib/auth.js';
import { textResponse, jsonResponse } from '../lib/http.js';

// Long enough to sign in (including an email round trip), short enough to
// bound how long an unfinished authorization request can be replayed.
const STATE_TTL_SECONDS = 600;
const STATE_KEY_PREFIX = 'mcp-oauth-req:';

async function storeAuthRequest(env, oauthReqInfo) {
	const stateToken = crypto.randomUUID();
	await env.OAUTH_KV.put(STATE_KEY_PREFIX + stateToken, JSON.stringify(oauthReqInfo), {
		expirationTtl: STATE_TTL_SECONDS,
	});
	return stateToken;
}

async function peekAuthRequest(env, stateToken) {
	if (!stateToken) return null;
	const raw = await env.OAUTH_KV.get(STATE_KEY_PREFIX + stateToken);
	return raw ? JSON.parse(raw) : null;
}

async function consumeAuthRequest(env, stateToken) {
	const info = await peekAuthRequest(env, stateToken);
	if (info) await env.OAUTH_KV.delete(STATE_KEY_PREFIX + stateToken);
	return info;
}

/**
 * GET /authorize — the entry point an MCP client's browser opens. Parses the
 * OAuth request, stashes it under a short-lived state token, and hands off to
 * the SPA's consent page (an ordinary frontend route, so it gets the site's
 * normal login UI for free).
 */
export async function handleAuthorize(request, env) {
	const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	if (!oauthReqInfo.clientId) return textResponse('Invalid request: missing client_id.', 400, new Headers());
	const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
	if (!client) return textResponse('Unknown OAuth client.', 400, new Headers());

	const state = await storeAuthRequest(env, oauthReqInfo);
	const url = new URL('/oauth/authorize', request.url);
	url.searchParams.set('state', state);
	return Response.redirect(url.toString(), 302);
}

/**
 * GET /oauth/request — consent-screen data for a pending state token: which
 * client is asking, what it wants, and where to send the user back on denial.
 * Public (no auth) — the state token itself is the capability, and it's a
 * random, single-use, 10-minute-lived value nobody else can guess.
 */
export async function handleOAuthRequest(request, env, url, cors) {
	const state = url.searchParams.get('state') || '';
	const oauthReqInfo = await peekAuthRequest(env, state);
	if (!oauthReqInfo) {
		return jsonResponse({ error: 'This sign-in request has expired. Reconnect from your MCP client.' }, 404, cors);
	}
	const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
	return jsonResponse(
		{
			clientName: client?.clientName || oauthReqInfo.clientId,
			redirectUri: oauthReqInfo.redirectUri,
			scope: oauthReqInfo.scope,
			clientState: oauthReqInfo.state,
		},
		200,
		cors,
	);
}

/**
 * POST /oauth/approve — the user clicked "Approve" on the consent screen.
 * Verifies their Supabase session, then mints the grant. `props` carries the
 * Supabase session forward so the MCP connection can call the hub's normal,
 * unchanged endpoints on the user's behalf (see routes/mcp.js).
 */
export async function handleOAuthApprove(request, env, url, cors) {
	const user = await verifySupabaseUser(env, bearerToken(request));
	if (!user) return jsonResponse({ error: 'Please sign in first.' }, 401, cors);
	if (!displayNameOf(user)) {
		return jsonResponse({ error: 'Set a display name in the web app before connecting an MCP client.' }, 403, cors);
	}

	let body;
	try {
		body = await request.json();
	} catch (e) {
		return jsonResponse({ error: 'Invalid JSON body.' }, 400, cors);
	}
	if (!body || typeof body.refreshToken !== 'string' || !body.refreshToken) {
		return jsonResponse({ error: 'Missing refreshToken.' }, 400, cors);
	}

	const oauthReqInfo = await consumeAuthRequest(env, typeof body.state === 'string' ? body.state : '');
	if (!oauthReqInfo) {
		return jsonResponse({ error: 'This sign-in request has expired. Reconnect from your MCP client.' }, 404, cors);
	}

	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReqInfo,
		userId: user.id,
		scope: oauthReqInfo.scope,
		metadata: { label: displayNameOf(user) },
		props: {
			supabaseUserId: user.id,
			supabaseAccessToken: bearerToken(request),
			supabaseRefreshToken: body.refreshToken,
		},
	});
	return jsonResponse({ redirectTo }, 200, cors);
}
