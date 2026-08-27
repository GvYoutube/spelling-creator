// The route table, minus anything that only one host can serve.
//
// Both entry points build on this: src/index.js (the Cloudflare Worker) and
// src/node/server.js (a plain Node process). Everything here runs on either —
// the lesson hub, images, git history, proposals, moderation, notifications,
// profiles, the AI flow, the feeds. It reaches storage through the platform seam
// (src/platform/) and Postgres over HTTP, and touches no runtime global that
// isn't web-standard.
//
// What is NOT here is the handful of things that genuinely need Cloudflare: live
// collaboration and the remote MCP endpoint (both Durable Objects), crawler
// prerendering and og-image screenshots (Browser Rendering). The Worker entry
// registers those itself. A self-hosted instance does without them, which is why
// they are absent rather than stubbed — a stub would be a promise the host can't
// keep.
//
// Route order is load-bearing in two ways, and both are why registration is a
// function rather than a module-level side effect. Deeper paths must come before
// broader ones (`/lessons/:id/comments` before `/lessons/*`), and the frontend
// catch-all must come last — after whatever extra routes an entry adds, or it
// would swallow them. Hence `registerFrontend`, called by each entry once it has
// finished adding its own.

import { Hono } from 'hono';

import { allowedHostnames, corsHeaders } from './lib/cors.js';

import { handleAi } from './routes/ai.js';
import { handleImageGet, handleImagePut } from './routes/images.js';
import { handleGit } from './routes/git.js';
import { handleLessons } from './routes/lessons.js';
import { handleComments, handleCommentEdit } from './routes/comments.js';
import { handlePulls } from './routes/pulls.js';
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
import { handleDiagnostics, handleHealth } from './routes/diagnostics.js';

// Per-request handles the route handlers expect, derived from the Hono context.
// Exported because the entries' own routes take the same arguments.
export const req = (c) => c.req.raw;
export const cors = (c) => c.get('cors');
export const urlOf = (c) => new URL(c.req.url);

/**
 * Build the app with every route both hosts can serve.
 *
 * The caller adds its host-specific routes and then calls `registerFrontend`.
 *
 * @returns {import('hono').Hono}
 */
export function createApp() {
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

	// Lesson images, addressed by content hash. GET/HEAD is public; PUT is
	// authenticated and verifies the body against the hash. Registered before the
	// frontend fall-through so the SPA catch-all never shadows it.
	app.on(['GET', 'HEAD'], '/images/:hash', (c) => handleImageGet(req(c), c.env, c.executionCtx, c.req.param('hash')));
	app.put('/images/:hash', (c) => handleImagePut(req(c), c.env, c.req.param('hash'), cors(c)));

	// A lesson's version history, stored as a git packfile. GET is public (so
	// anyone can fork a published lesson by cloning it); PUT is the author's only.
	// Its own top-level path, deliberately not under /lessons/*, so it can't be
	// shadowed by the broader lesson match below.
	app.all('/git/:id/:action', (c) => handleGit(req(c), c.env, c.req.param('id'), `/${c.req.param('action')}`, cors(c)));

	// Lesson-hub routes (Postgres-backed). /lessons/:id/comments is its own handler,
	// so it must be registered before the broader /lessons/* match. Editing one comment
	// (author-only) is a deeper path under it, registered first for the same reason.
	app.all('/lessons/:id/comments/:commentId', (c) =>
		handleCommentEdit(req(c), c.env, c.req.param('id'), c.req.param('commentId'), cors(c)),
	);
	app.all('/lessons/:id/comments', (c) => handleComments(req(c), c.env, c.req.param('id'), cors(c)));
	// A learner's own answers from interactive mode. Private to the signed-in caller
	// — see the privacy note at the top of routes/lessonResponses.js. Registered
	// before the broader /lessons/* match for the same reason the comment routes are.
	app.all('/lessons/:id/responses/:responseId', (c) =>
		handleLessonResponseDelete(req(c), c.env, c.req.param('id'), c.req.param('responseId'), cors(c)),
	);
	app.all('/lessons/:id/responses', (c) => handleLessonResponses(req(c), c.env, c.req.param('id'), cors(c)));
	// Pull requests against a lesson: someone proposing changes from their fork, for
	// the lesson's author or a trusted collaborator to review and merge. Deeper paths
	// first, for the same reason as the comment routes above.
	app.all('/lessons/:id/pulls/:pullId/:action', (c) =>
		handlePulls(req(c), c.env, c.req.param('id'), c.req.param('pullId'), c.req.param('action'), cors(c)),
	);
	app.all('/lessons/:id/pulls', (c) => handlePulls(req(c), c.env, c.req.param('id'), '', '', cors(c)));
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
	// /oauth/authorize) are named the way they are. This app sees every request
	// before the static assets do, so a route here with the same path as a
	// client-side one would swallow that page's direct loads/reloads (a real GET,
	// with no Authorization header) and this handler would always answer them with
	// 401, never actually serving the SPA.
	app.all('/mod', (c) => handleModeration(req(c), c.env, urlOf(c), cors(c)));
	app.all('/mod/*', (c) => handleModeration(req(c), c.env, urlOf(c), cors(c)));

	// Is this instance alive, and are the things it depends on working? Named with
	// a leading underscore so they cannot collide with a client-side route, the
	// same reason /mod and /profiles are named as they are.
	app.get('/_health', (c) => handleHealth(cors(c)));
	app.get('/_diagnostics', (c) => handleDiagnostics(req(c), c.env, cors(c)));

	// One-time admin backfills, secret-gated (X-Admin-Token), POST-only.
	app.post('/admin/migrate-images', (c) => handleAdminMigrateImages(req(c), c.env, cors(c)));
	app.post('/admin/backfill-webp', (c) => handleAdminBackfillWebp(req(c), c.env, c.executionCtx, cors(c)));

	// Dynamic sitemap + robots.txt, built from the same lesson listing the hub uses.
	app.get('/sitemap.xml', (c) => handleSitemap(req(c), c.env, urlOf(c)));
	app.get('/robots.txt', (c) => handleRobots(req(c), c.env, urlOf(c)));

	// Atom feed of the latest published lessons across the hub ("RSS" in the UI).
	app.get('/feed.xml', (c) => handleLessonsFeed(req(c), c.env, urlOf(c), cors(c)));

	// Aggregated list of every spelling word taught across the hub, for the
	// homepage's floating-words animation. Rebuilt at most once every couple of days
	// (cached); see routes/spelling-words.js.
	app.get('/spelling-words.json', (c) => handleSpellingWords(req(c), c.env, urlOf(c), cors(c)));

	// Turnstile-gated AI / image flow. The client posts to the API root (`POST /`).
	// A POST, so it does not collide with the GET/HEAD frontend catch-all.
	app.post('/', (c) => handleAi(req(c), c.env, cors(c), c.get('allowed')));

	return app;
}

/**
 * Register the frontend fall-through: every GET/HEAD that matched nothing above
 * is a request for the SPA.
 *
 * Separate from `createApp` because it must be registered *last*, after the
 * calling entry has added its own routes — a catch-all registered before them
 * would answer their requests instead.
 *
 * @param {import('hono').Hono} app
 * @param {(request: Request, env: object, ctx: object, url: URL) => Promise<Response>} frontend
 */
export function registerFrontend(app, frontend) {
	app.on(['GET', 'HEAD'], '*', (c) => frontend(req(c), c.env, c.executionCtx, urlOf(c)));
}
