import { Hono } from 'hono';

import { CollabRoom } from './collab-room.js';

import { allowedHostnames, corsHeaders } from './lib/cors.js';

import { handleAi } from './routes/ai.js';
import { handleImageGet, handleImagePut } from './routes/images.js';
import { handleLessons } from './routes/lessons.js';
import { handleComments } from './routes/comments.js';
import { handleTextFeedback } from './routes/feedback.js';
import { handleNotifications } from './routes/notifications.js';
import { handleProfile } from './routes/profile.js';
import { handleUsers } from './routes/users.js';
import { handleModeration } from './routes/moderation.js';
import { handleAdminMigrateImages, handleAdminBackfillWebp } from './routes/admin.js';
import { handleSitemap, handleRobots, handleLessonsFeed } from './routes/seo.js';
import { ogImage, handleFrontend } from './routes/render.js';
import { handleCollab } from './routes/collab.js';

// Re-export the Durable Object class so Wrangler can bind it (the migration in
// wrangler.jsonc registers COLLAB_ROOM -> CollabRoom). See routes/collab.js.
export { CollabRoom };

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

// Lesson-hub routes (Supabase-backed). /lessons/:id/comments is its own handler,
// so it must be registered before the broader /lessons/* match.
app.all('/lessons/:id/comments', (c) => handleComments(req(c), c.env, c.req.param('id'), cors(c)));
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

// Public user-profile routes: a user's profile JSON and their Atom activity feed.
// The /profiles prefix avoids colliding with the SPA's /users/:id page.
app.all('/profiles', (c) => handleUsers(req(c), c.env, urlOf(c), cors(c)));
app.all('/profiles/*', (c) => handleUsers(req(c), c.env, urlOf(c), cors(c)));

// Moderation routes: the admin/moderator privilege layer.
app.all('/moderation', (c) => handleModeration(req(c), c.env, urlOf(c), cors(c)));
app.all('/moderation/*', (c) => handleModeration(req(c), c.env, urlOf(c), cors(c)));

// One-time admin backfills, secret-gated (X-Admin-Token), POST-only.
app.post('/admin/migrate-images', (c) => handleAdminMigrateImages(req(c), c.env, cors(c)));
app.post('/admin/backfill-webp', (c) => handleAdminBackfillWebp(req(c), c.env, c.executionCtx, cors(c)));

// Dynamic sitemap + robots.txt, built from the same Supabase listing the hub uses.
app.get('/sitemap.xml', (c) => handleSitemap(req(c), c.env, urlOf(c)));
app.get('/robots.txt', (c) => handleRobots(req(c), c.env, urlOf(c)));

// Atom feed of the latest published lessons across the hub ("RSS" in the UI).
app.get('/feed.xml', (c) => handleLessonsFeed(req(c), c.env, urlOf(c), cors(c)));

// Open Graph preview image: a headless-Chromium screenshot of an in-site page.
app.get('/og-image', (c) => ogImage(req(c), c.env, c.executionCtx, urlOf(c)));

// Live-collaboration WebSocket. A WS upgrade arrives as a GET, so this must be
// registered before the GET/HEAD frontend fall-through below would shadow it.
app.get('/collab', (c) => handleCollab(req(c), c.env, urlOf(c), cors(c)));
app.get('/collab/*', (c) => handleCollab(req(c), c.env, urlOf(c), cors(c)));

// Turnstile-gated AI / image flow. The client posts to the API root (`POST /`).
app.post('/', (c) => handleAi(req(c), c.env, cors(c), c.get('allowed')));

// Everything else that is a GET/HEAD is a request for the frontend: serve the
// SPA's static assets, or a prerendered snapshot for crawlers. Registered last so
// it only runs when no route above matched.
app.on(['GET', 'HEAD'], '*', (c) => handleFrontend(req(c), c.env, c.executionCtx, urlOf(c)));

export default app;
