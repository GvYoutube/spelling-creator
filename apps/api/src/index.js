import { Hono } from 'hono';

import { CollabRoom } from './collab-room.js';

import { allowedHostnames, corsHeaders } from './lib/cors.js';

import { handleAi } from './routes/ai.js';
import { handleImageGet, handleImagePut } from './routes/images.js';
import { handleGit } from './routes/git.js';
import { handleLessons } from './routes/lessons.js';
import { handleComments, handleCommentEdit } from './routes/comments.js';
import { handleLessonResponses, handleLessonResponseDelete } from './routes/lessonResponses.js';
import { handleTextFeedback } from './routes/feedback.js';
import { handleNotifications } from './routes/notifications.js';
import { handleProfile } from './routes/profile.js';
import { handleUsers } from './routes/users.js';
import { handleFollow, handleFollowList, handleFollowingFeed } from './routes/follows.js';
import { handleModeration } from './routes/moderation.js';
import { handleAdminMigrateImages, handleAdminBackfillWebp } from './routes/admin.js';
import { handleSitemap, handleRobots, handleLessonsFeed } from './routes/seo.js';
import { handleSpellingWords } from './routes/spelling-words.js';
import { ogImage, handleFrontend } from './routes/render.js';
import { handleCollab } from './routes/collab.js';
import { HubMcp, registerOAuthConsentRoutes, buildOAuthProvider } from './routes/mcp.js';

// Re-export the Durable Object classes so Wrangler can bind them (the
// migrations in wrangler.jsonc register COLLAB_ROOM -> CollabRoom and
// MCP_OBJECT -> HubMcp). See routes/collab.js and routes/mcp.js.
export { CollabRoom, HubMcp };

// Per-request handles the route handlers expect, derived from the Hono context.
const req = (c) => c.req.raw;
const cors = (c) => c.get('cors');
const urlOf = (c) => new URL(c.req.url);

const app = new Hono();

// Compute the CORS headers + allow-list once per request and stash them on the
// context. Answer the CORS preflight here, before any routing or body parsing.
app.use('*', async (c, next) => {
	const allowed = allowedHostnames(c.env);
	c.set('allowed', allowed);
	c.set('cors', corsHeaders(c.req.raw, allowed));
	if (c.req.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: c.get('cors') });
	}
	await next();
});

// Lesson images stored in R2, addressed by content hash. GET/HEAD is public; PUT
// is authenticated and verifies the body against the hash. Registered before the
// frontend fall-through so the SPA catch-all never shadows it.
app.on(['GET', 'HEAD'], '/images/:hash', (c) => handleImageGet(req(c), c.env, c.executionCtx, c.req.param('hash')));
app.put('/images/:hash', (c) => handleImagePut(req(c), c.env, c.req.param('hash'), cors(c)));

// A lesson's version history, stored in R2 as a git packfile. GET is public (so
// anyone can fork a published lesson by cloning it); PUT is the author's only.
// Its own top-level path, deliberately not under /lessons/*, so it can't be
// shadowed by the broader lesson match below.
app.all('/git/:id/:action', (c) => handleGit(req(c), c.env, c.req.param('id'), `/${c.req.param('action')}`, cors(c)));

// Lesson-hub routes (Supabase-backed). /lessons/:id/comments is its own handler,
// so it must be registered before the broader /lessons/* match. Editing one comment
// (author-only) is a deeper path under it, registered first for the same reason.
app.all('/lessons/:id/comments/:commentId', (c) => handleCommentEdit(req(c), c.env, c.req.param('id'), c.req.param('commentId'), cors(c)));
app.all('/lessons/:id/comments', (c) => handleComments(req(c), c.env, c.req.param('id'), cors(c)));
// A learner's own answers from interactive mode. Private to the signed-in caller
// — see the privacy note at the top of routes/lessonResponses.js. Registered
// before the broader /lessons/* match for the same reason the comment routes are.
app.all('/lessons/:id/responses/:responseId', (c) =>
	handleLessonResponseDelete(req(c), c.env, c.req.param('id'), c.req.param('responseId'), cors(c)),
);
app.all('/lessons/:id/responses', (c) => handleLessonResponses(req(c), c.env, c.req.param('id'), cors(c)));
app.all('/lessons', (c) => handleLessons(req(c), c.env, urlOf(c), cors(c)));
app.all('/lessons/*', (c) => handleLessons(req(c), c.env, urlOf(c), cors(c)));

// Negative feedback on a cached AI text suggestion (Supabase-JWT gated, not
// Turnstile, so handled before the AI flow).
app.post('/ai-text/dislike', (c) => handleTextFeedback(req(c), c.env, cors(c)));

// Notification routes: a user's notifications and the "send link" action.
app.all('/notifications', (c) => handleNotifications(req(c), c.env, urlOf(c), cors(c)));
app.all('/notifications/*', (c) => handleNotifications(req(c), c.env, urlOf(c), cors(c)));

// Profile routes: setting the display name shown in place of an email, and bio.
app.all('/profile', (c) => handleProfile(req(c), c.env, urlOf(c), cors(c)));
app.all('/profile/*', (c) => handleProfile(req(c), c.env, urlOf(c), cors(c)));

// Following routes. /profiles/:id/follow (POST to follow, DELETE to unfollow) and
// the followers/following lists are their own handlers, so — like
// /lessons/:id/comments — they must be registered before the broader /profiles/*
// match below. /following/activity is the signed-in user's home feed of activity
// from the people they follow.
app.all('/profiles/:id/follow', (c) => handleFollow(req(c), c.env, c.req.param('id'), cors(c)));
app.all('/profiles/:id/followers', (c) => handleFollowList(req(c), c.env, c.req.param('id'), 'followers', cors(c)));
app.all('/profiles/:id/following', (c) => handleFollowList(req(c), c.env, c.req.param('id'), 'following', cors(c)));
app.get('/following/activity', (c) => handleFollowingFeed(req(c), c.env, urlOf(c), cors(c)));

// Public user-profile routes: a user's profile JSON and their Atom activity feed.
// The /profiles prefix avoids colliding with the SPA's /users/:id page.
app.all('/profiles', (c) => handleUsers(req(c), c.env, urlOf(c), cors(c)));
app.all('/profiles/*', (c) => handleUsers(req(c), c.env, urlOf(c), cors(c)));

// Moderation routes: the admin/moderator privilege layer. Named "/mod", not
// "/moderation", so it can't collide with the SPA's own "/moderation" page
// route — same reason /profiles (not /users) above and /authorize (not
// /oauth/authorize) below are named the way they are. run_worker_first means
// this Hono app sees every request before the static assets do, so a route
// here with the same path as a client-side one would swallow that page's
// direct loads/reloads (a real GET, with no Authorization header) and this
// handler would always answer them with 401, never actually serving the SPA.
app.all('/mod', (c) => handleModeration(req(c), c.env, urlOf(c), cors(c)));
app.all('/mod/*', (c) => handleModeration(req(c), c.env, urlOf(c), cors(c)));

// One-time admin backfills, secret-gated (X-Admin-Token), POST-only.
app.post('/admin/migrate-images', (c) => handleAdminMigrateImages(req(c), c.env, cors(c)));
app.post('/admin/backfill-webp', (c) => handleAdminBackfillWebp(req(c), c.env, c.executionCtx, cors(c)));

// Dynamic sitemap + robots.txt, built from the same Supabase listing the hub uses.
app.get('/sitemap.xml', (c) => handleSitemap(req(c), c.env, urlOf(c)));
app.get('/robots.txt', (c) => handleRobots(req(c), c.env, urlOf(c)));

// Atom feed of the latest published lessons across the hub ("RSS" in the UI).
app.get('/feed.xml', (c) => handleLessonsFeed(req(c), c.env, urlOf(c), cors(c)));

// Aggregated list of every spelling word taught across the hub, for the
// homepage's floating-words animation. Rebuilt at most once every couple of days
// (cached in KV); see routes/spelling-words.js.
app.get('/spelling-words.json', (c) => handleSpellingWords(req(c), c.env, urlOf(c), cors(c)));

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

// Turnstile-gated AI / image flow. The client posts to the API root (`POST /`).
app.post('/', (c) => handleAi(req(c), c.env, cors(c), c.get('allowed')));

// Everything else that is a GET/HEAD is a request for the frontend: serve the
// SPA's static assets, or a prerendered snapshot for crawlers. Registered last so
// it only runs when no route above matched.
app.on(['GET', 'HEAD'], '*', (c) => handleFrontend(req(c), c.env, c.executionCtx, urlOf(c)));

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
