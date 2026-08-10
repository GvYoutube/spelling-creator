// Server-side rendering for the app's public read-only routes.
//
// /hub, /hub/:id and /users/:id are the pages whose primary content is a public
// JSON fetch, so the Worker can fetch it and render the real React tree before
// the browser has run a line of JavaScript. Everyone gets the rendered HTML —
// not just crawlers, which is what separates this from the Chromium prerender
// in render.js (that one still covers the routes listed below as not renderable).
//
// What this deliberately does NOT do is render anything personalised. The
// Supabase session lives in localStorage behind PKCE and is invisible to a
// server, so the render is always anonymous and the signed-in parts of the page
// fill in when the client hydrates. That is the property that makes SSR
// tractable here at all: every route worth rendering is a public read.
//
// Failure at request time is always soft: a failed data fetch or a render error
// falls through to the static SPA shell, which is exactly what the app served
// before this route existed. A *missing* server bundle is not a runtime case at
// all — the import below is static, so the Worker fails to bundle, which is why
// every script that reaches wrangler builds it first.

import { configureCore } from '@spelling-creator/core/config';
import { fetchLesson, fetchPublishedLessons } from '@spelling-creator/core/lessons';
import { fetchUserProfile } from '@spelling-creator/core/users';

// The app compiled for workerd — see apps/web/vite.config.js and
// src/entry-server.jsx. This is a build artifact, so `pnpm build` in apps/web
// has to have run before the Worker is bundled; the root `pnpm deploy` chains
// them in that order.
import { render } from '../../../web/dist-ssr/entry-server.js';

const HUB_PATH = /^\/hub\/?$/;
// A lesson and any of its tabs: /hub/:id, /hub/:id/history,
// /hub/:id/proposals/:prId. They are all views of one lesson, and one fetch
// serves every one of them — the tab decides what to draw with it.
//
// Matching the tabs is not optional. The service worker's navigateFallback
// denylist excludes the whole of /hub/* from the precached shell (WORKER_PATHS
// in apps/web/vite.config.js), on the grounds that the Worker answers those
// paths itself. If this regex stopped at /hub/:id, a tab would be excluded from
// the shell *and* unmatched here: online it would fall through to the SPA
// shell and still work, but offline — where there is no Worker to fall through
// to — it would fail outright. The two lists have to agree.
const LESSON_PATH = /^\/hub\/([^/]+)(?:\/[^/]+)*\/?$/;
const PROFILE_PATH = /^\/users\/([^/]+)\/?$/;

/**
 * Which page (if any) this request should be server-rendered as.
 * @returns {{key: string, load: (cfg: object) => Promise<object>}|null}
 */
function matchRoute(url) {
	if (HUB_PATH.test(url.pathname)) {
		return { key: 'lessons', load: () => fetchPublishedLessons() };
	}
	const lesson = url.pathname.match(LESSON_PATH);
	if (lesson) {
		// No access token: a private draft 404s here and the author sees it after
		// hydration, when their own authenticated fetch runs.
		return { key: 'lesson', load: () => fetchLesson(decodeURIComponent(lesson[1])) };
	}
	const profile = url.pathname.match(PROFILE_PATH);
	if (profile) {
		return { key: 'profile', load: () => fetchUserProfile(decodeURIComponent(profile[1])) };
	}
	return null;
}

/**
 * True for requests this route should try to render: a GET navigation to one of
 * the three public read routes.
 */
export function shouldServerRender(request, url) {
	if (request.method !== 'GET') return false;
	// The prerender browser sets this when it loads a page; leave it the plain
	// shell so a snapshot of an already-rendered page can't nest.
	if (url.searchParams.has('__prerender')) return false;
	const accept = request.headers.get('accept') || '';
	if (!accept.includes('text/html')) return false;
	return matchRoute(url) !== null;
}

// The build-time configuration the browser passes to core from import.meta.env
// (see apps/web/src/main.jsx); here it comes from the Worker's own bindings so
// that core's fetches resolve and `hasSupabase()` agrees with what the client
// will compute — a page that renders signed-out chrome on the server and
// signed-out chrome on the client's first pass is a page that hydrates cleanly.
function coreConfig(env, url) {
	return {
		// This Worker *is* the API, so the origin serving the page is always the
		// right one to fetch from — no configuration, and it follows the request
		// into local dev and any preview deployment.
		apiUrl: url.origin,
		supabaseUrl: env.SUPABASE_URL,
		supabaseAnonKey: env.SUPABASE_ANON_KEY,
		googleClientId: '',
		turnstileSiteKey: '',
	};
}

// The built index.html, which carries the hashed script/style tags, the PWA
// manifest link and the pre-paint theme script. Rendering into it rather than
// reproducing it keeps this route out of the business of knowing asset names.
async function shell(env, url) {
	const res = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`));
	if (!res.ok) throw new Error(`Could not read the app shell (${res.status}).`);
	return res.text();
}

// index.html carries site-wide social defaults for the pages that aren't
// rendered here. On a rendered page they are duplicates of what <DocumentMeta>
// just produced, and a scraper reading the *first* og:title it finds would get
// the generic one — so the generic set comes out and the page's own goes in.
// Everything else in <head> (viewport, theme-color, icons, feeds, scripts) is
// untouched.
function stripDefaultMetadata(html) {
	return html
		.replace(/<title>[\s\S]*?<\/title>\s*/i, '')
		.replace(/<meta\s+name="description"[^>]*>\s*/gi, '')
		.replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, '')
		.replace(/<meta\s+name="twitter:[^"]*"[^>]*>\s*/gi, '');
}

// Serialise the page's data for the client to hydrate against. The escape is
// the one that matters in an inline <script>: a "</script>" occurring inside
// any string value would otherwise close the block early.
function bootstrapScript(path, data) {
	const json = JSON.stringify({ path, data }).replace(/</g, '\\u003c');
	return `<script>window.__SSR__=${json}</script>`;
}

/**
 * Render the page, or return null to let the caller fall back to the shell.
 */
export async function serverRender(request, env, ctx, url) {
	const route = matchRoute(url);
	if (!route) return null;

	const config = coreConfig(env, url);
	configureCore(config);

	let data;
	let html;
	try {
		// One subrequest back into this same Worker, through the very same core
		// module the browser calls — no server-specific client, which is what
		// keeps the two paths from drifting.
		data = { [route.key]: await route.load() };
		html = await shell(env, url);
	} catch (err) {
		console.error('SSR data/shell failed', url.pathname, err);
		return null;
	}

	let head;
	let body;
	try {
		({ head, body } = await render({
			url: url.toString(),
			config,
			data,
			signal: request.signal,
		}));
	} catch (err) {
		console.error('SSR render failed', url.pathname, err);
		return null;
	}

	// Function replacements, not strings. In a *string* replacement `$&`, `` $` ``,
	// `$'`, `$$` and `$1` are substitution syntax — and everything being spliced
	// in here carries user text (a lesson title, an author name, a profile bio).
	// A lesson titled `$'` would otherwise re-insert everything after the match,
	// duplicating the rest of the shell into the response. A function replacement
	// is taken literally.
	const page = stripDefaultMetadata(html)
		.replace('</head>', () => `${head}</head>`)
		.replace('<div id="root"></div>', () => `<div id="root">${body}</div>`)
		.replace('</body>', () => `${bootstrapScript(url.pathname, data)}</body>`);

	return new Response(page, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			// Deliberately not cached at the edge. The render is milliseconds of
			// CPU (unlike the Chromium prerender this replaces), and a lesson or a
			// profile that has just been edited should not be served stale to the
			// next visitor.
			'Cache-Control': 'no-cache',
			'X-Rendered': 'ssr',
		},
	});
}
