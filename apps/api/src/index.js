// The Cloudflare Worker entry point.
//
// The route table itself lives in src/app.js, shared with the Node entry
// (src/node/server.js). What is added here is everything only this host can
// serve: live collaboration and the remote MCP endpoint (Durable Objects), and
// crawler prerendering plus og-image screenshots (Browser Rendering).
//
// Those extras are registered before `registerFrontend`, because the frontend
// catch-all answers every unmatched GET and would otherwise swallow them.

import { createApp, cors, registerFrontend, req, urlOf } from './app.js';

import { CollabRoom } from './collab-room.js';
import { ogImage, handleFrontend } from './routes/render.js';
import { handleCollab } from './routes/collab.js';
import { HubMcp, registerOAuthConsentRoutes, buildOAuthProvider } from './routes/mcp.js';

// Re-export the Durable Object classes so Wrangler can bind them (the
// migrations in wrangler.jsonc register COLLAB_ROOM -> CollabRoom and
// MCP_OBJECT -> HubMcp). See routes/collab.js and routes/mcp.js.
export { CollabRoom, HubMcp };

const app = createApp();

// Open Graph preview image: a headless-Chromium screenshot of an in-site page.
app.get('/og-image', (c) => ogImage(req(c), c.env, c.executionCtx, urlOf(c)));

// Live-collaboration WebSocket. A WS upgrade arrives as a GET, so this must be
// registered before the GET/HEAD frontend fall-through below would shadow it.
app.get('/collab', (c) => handleCollab(req(c), c.env, urlOf(c), cors(c)));
app.get('/collab/*', (c) => handleCollab(req(c), c.env, urlOf(c), cors(c)));

// Consent screen backing the remote MCP OAuth flow. `/authorize`, `/token`, and
// `/register` are also reserved paths (the OAuthProvider wrap below implements
// `/token` + `/register` itself) — see routes/mcp.js and routes/oauth.js.
registerOAuthConsentRoutes(app);

// Everything else that is a GET/HEAD is a request for the frontend: server-render
// it, hand a crawler a prerendered snapshot, or serve the static asset.
registerFrontend(app, handleFrontend);

// The OAuthProvider wraps the whole app: it serves the MCP OAuth authorization
// server itself (/token, /register, discovery metadata) and the /mcp Streamable
// HTTP endpoint, and passes every other request through to `app` unchanged —
// see routes/mcp.js. Built fresh per request so its token-refresh callback can
// close over this request's env bindings.
export default {
	fetch(request, env, ctx) {
		return buildOAuthProvider(app, env).fetch(request, env, ctx);
	},
};
