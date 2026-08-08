// Crawler prerendering + Open Graph preview images + the frontend fall-through.
//
// The Worker serves the React SPA (env.ASSETS). Search engines and social
// scrapers that don't run JavaScript would otherwise only see the empty
// index.html shell, so we detect them by User-Agent and instead return a fully
// rendered HTML snapshot produced by headless Chromium (@cloudflare/puppeteer).
//
// Most of that job now belongs to routes/ssr.js, which renders /hub, /hub/:id
// and /users/:id with React for every visitor. What's left here is the tail:
// "/" (whose content is auth-gated, so an anonymous render is only ever the
// marketing splash) and any future route SSR doesn't reach. The og-image
// endpoint below is unaffected — it takes screenshots, which SSR cannot do.

import puppeteer from '@cloudflare/puppeteer';
import { textResponse } from '../lib/http.js';
import { serverRender, shouldServerRender } from './ssr.js';

// User-Agents of crawlers/scrapers worth prerendering for: search engines and
// the link-preview bots used by social/chat platforms.
const CRAWLER_UA =
	/googlebot|bingbot|slurp|duckduckbot|baiduspider|yandex|sogou|exabot|facebookexternalhit|facebot|twitterbot|linkedinbot|embedly|quora link preview|pinterest|slackbot|slack-imgproxy|vkshare|w3c_validator|whatsapp|telegrambot|discordbot|redditbot|applebot|petalbot|bytespider|ia_archiver|skypeuripreview|google-inspectiontool/i;

// Query flag the prerender browser appends when it loads the page, so the
// Worker serves the real SPA shell instead of recursively prerendering itself.
const PRERENDER_BYPASS = '__prerender';

function isCrawler(request) {
	const ua = request.headers.get('user-agent') || '';
	return CRAWLER_UA.test(ua);
}

// True for requests we should consider prerendering: a crawler GET for an HTML
// document (not a hashed asset like /assets/app.js or an image).
export function shouldPrerender(request, url) {
	if (request.method !== 'GET') return false;
	if (url.searchParams.has(PRERENDER_BYPASS)) return false;
	if (!isCrawler(request)) return false;
	// The /docs Rspress site is statically pre-rendered at build time, so its
	// HTML is already crawler-ready — no need to spin up a browser for it.
	if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) return false;
	const accept = request.headers.get('accept') || '';
	const isDoc = accept.includes('text/html') || !/\.[a-z0-9]+$/i.test(url.pathname);
	return isDoc;
}

// Render the page with headless Chromium and return its serialized HTML. Results
// are cached (keyed by path) so repeat crawler hits don't each spin up a browser.
async function prerender(request, env, ctx, url) {
	const cache = caches.default;
	// Cache under a synthetic key so a prerendered snapshot is never accidentally
	// served to a real user requesting the same path.
	const cacheKey = new Request(`${url.origin}${url.pathname}?${PRERENDER_BYPASS}=cache`, { method: 'GET' });
	const hit = await cache.match(cacheKey);
	if (hit) return hit;

	// The browser loads this same Worker; the bypass flag stops it prerendering
	// itself, so it gets the static SPA shell + assets and renders the page.
	const target = new URL(url);
	target.searchParams.set(PRERENDER_BYPASS, '1');

	let browser;
	try {
		browser = await puppeteer.launch(env.BROWSER);
		const page = await browser.newPage();

		// Skip resources that don't affect the rendered markup we capture: images,
		// fonts, media, and the third-party widgets (Turnstile, Google Identity)
		// that only matter for live interaction. This keeps the render fast and
		// lets the page reach network-idle promptly.
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const type = req.resourceType();
			if (type === 'image' || type === 'media' || type === 'font') return req.abort();
			if (/challenges\.cloudflare\.com|accounts\.google\.com|fonts\.g(oogleapis|static)\.com/.test(req.url())) {
				return req.abort();
			}
			req.continue();
		});

		await page.goto(target.toString(), { waitUntil: 'networkidle0', timeout: 20000 });
		const html = await page.content();

		const response = new Response(html, {
			status: 200,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				// Let the edge serve repeat crawler hits without re-rendering.
				'Cache-Control': 'public, max-age=3600',
				'X-Prerendered': '1',
			},
		});
		ctx.waitUntil(cache.put(cacheKey, response.clone()));
		return response;
	} catch (err) {
		// If rendering fails (timeout, quota, etc.) fall back to the SPA shell so
		// the crawler still receives valid HTML rather than an error.
		return env.ASSETS.fetch(request);
	} finally {
		if (browser) await browser.close();
	}
}

// Standard Open Graph / Twitter preview image dimensions (1.91:1).
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// GET /og-image?path=/hub/:id — render the given in-site path with the same
// headless Chromium used for prerendering and return a PNG screenshot sized for
// social link previews. The per-page <meta property="og:image"> the SPA writes
// (see web/src/lib/seo.js) points here, so the preview a scraper fetches is a
// live snapshot of the actual page. Results are edge-cached by path so repeat
// hits don't each spin up a browser.
export async function ogImage(request, env, ctx, url) {
	if (!env.BROWSER) return textResponse('Browser rendering unavailable.', 503);

	// Only ever screenshot a same-site path. Strip any query/hash so the cache
	// key (and the rendered preview) stays stable per page.
	let path = url.searchParams.get('path') || '/';
	if (!path.startsWith('/') || path.startsWith('//')) path = '/';
	path = path.split(/[?#]/)[0];

	const cache = caches.default;
	const cacheKey = new Request(`${url.origin}/og-image?path=${encodeURIComponent(path)}`, { method: 'GET' });
	const hit = await cache.match(cacheKey);
	if (hit) return hit;

	// Load this same Worker with the bypass flag so it serves the real SPA shell
	// + assets (rather than recursively prerendering) and renders the page.
	const target = new URL(`${url.origin}${path}`);
	target.searchParams.set(PRERENDER_BYPASS, '1');

	let browser;
	try {
		browser = await puppeteer.launch(env.BROWSER);
		const page = await browser.newPage();
		await page.setViewport({ width: OG_WIDTH, height: OG_HEIGHT, deviceScaleFactor: 1 });

		// Unlike prerendering we keep images and fonts — they're exactly what the
		// screenshot is meant to capture — and only block the interactive
		// third-party widgets (Turnstile, Google Identity) so the page can still
		// reach network-idle promptly.
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			if (/challenges\.cloudflare\.com|accounts\.google\.com/.test(req.url())) {
				return req.abort();
			}
			req.continue();
		});

		await page.goto(target.toString(), { waitUntil: 'networkidle0', timeout: 20000 });
		const buffer = await page.screenshot({
			type: 'png',
			clip: { x: 0, y: 0, width: OG_WIDTH, height: OG_HEIGHT },
		});

		const response = new Response(buffer, {
			status: 200,
			headers: {
				'Content-Type': 'image/png',
				// Let the edge serve repeat scraper hits without re-rendering.
				'Cache-Control': 'public, max-age=3600',
				'X-Og-Image': '1',
			},
		});
		ctx.waitUntil(cache.put(cacheKey, response.clone()));
		return response;
	} catch (err) {
		return textResponse('Failed to render preview image.', 500);
	} finally {
		if (browser) await browser.close();
	}
}

// Serve the frontend, in preference order:
//
//   1. Server-render it, for everyone, if it's one of the public read routes
//      (routes/ssr.js). Returns null if it isn't, or if anything went wrong.
//   2. Prerender it with headless Chromium, for crawlers only, on the routes
//      SSR doesn't cover — today that's "/" and nothing else, since the rest
//      are auth-gated pages no crawler has any business indexing.
//   3. Hand back the static asset (env.ASSETS resolves SPA routes to index.html
//      via not_found_handling).
export async function handleFrontend(request, env, ctx, url) {
	if (shouldServerRender(request, url)) {
		const rendered = await serverRender(request, env, ctx, url);
		if (rendered) return rendered;
	}
	if (env.BROWSER && shouldPrerender(request, url)) {
		return prerender(request, env, ctx, url);
	}
	return env.ASSETS.fetch(request);
}
