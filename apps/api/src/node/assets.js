// The static-asset server, standing in for Cloudflare's `env.ASSETS` binding.
//
// The Worker serves the built SPA (and the docs site inside it) from an asset
// bundle uploaded alongside the code, reached through `env.ASSETS.fetch(request)`
// with `not_found_handling: "single-page-application"` — which is what makes a
// deep link like /hub/abc return index.html for the router to pick up. This is
// the same contract over a directory on disk, so `handleFrontend` and the SSR
// path (which fetches /index.html through it) work unchanged.
//
// A production deployment will usually put a reverse proxy in front of this and
// let it serve the directory directly, which is faster and handles ranges and
// compression properly. This exists so that a deployment doesn't *have* to: one
// process, one port, and it works.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const CONTENT_TYPES = new Map(
	Object.entries({
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.mjs': 'text/javascript; charset=utf-8',
		'.css': 'text/css; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.map': 'application/json; charset=utf-8',
		'.svg': 'image/svg+xml',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.gif': 'image/gif',
		'.webp': 'image/webp',
		'.avif': 'image/avif',
		'.ico': 'image/x-icon',
		'.woff': 'font/woff',
		'.woff2': 'font/woff2',
		'.ttf': 'font/ttf',
		'.txt': 'text/plain; charset=utf-8',
		'.xml': 'application/xml; charset=utf-8',
		'.webmanifest': 'application/manifest+json',
		'.wasm': 'application/wasm',
	}),
);

const contentType = (path) => CONTENT_TYPES.get(extname(path).toLowerCase()) || 'application/octet-stream';

/**
 * Vite writes hashed filenames under /assets/, so those bytes never change for a
 * given URL and can be cached forever. Everything else — index.html above all —
 * must be revalidated, or a deploy would leave browsers on the old shell
 * pointing at asset names that no longer exist.
 */
function cacheControl(pathname) {
	return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/**
 * Resolve a URL path to a file inside `root`, or null if it escapes.
 *
 * The traversal check is the point: a request for /../../etc/passwd must not be
 * served, and `decodeURIComponent` means the check has to happen after decoding
 * rather than on the raw path.
 */
function resolveWithin(root, pathname) {
	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch (e) {
		return null;
	}
	const candidate = resolve(join(root, normalize(decoded)));
	return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

/** The file at `path`, or the index.html inside it if it is a directory. */
async function fileAt(path) {
	try {
		const info = await stat(path);
		if (info.isDirectory()) return await fileAt(join(path, 'index.html'));
		return info.isFile() ? { path, size: info.size } : null;
	} catch (e) {
		return null;
	}
}

/**
 * An `env.ASSETS`-shaped static file server over `directory`.
 *
 * @param {string} directory The built SPA, i.e. apps/web/dist.
 * @returns {{ fetch: (request: Request) => Promise<Response> }}
 */
export function assetServer(directory) {
	const root = resolve(directory);

	async function respond(request, path, status) {
		const found = await fileAt(path);
		if (!found) return null;
		// The type comes from the file that was actually resolved, not from what was
		// asked for: a request for "/" resolves to index.html, and typing it by the
		// requested path would serve the shell as application/octet-stream — which
		// browsers offer to download rather than render.
		const headers = new Headers({
			'Content-Type': contentType(found.path),
			'Cache-Control': cacheControl(new URL(request.url).pathname),
			'Content-Length': String(found.size),
		});
		// HEAD gets the headers and none of the bytes.
		if (request.method === 'HEAD') return new Response(null, { status, headers });
		return new Response(Readable.toWeb(createReadStream(found.path)), { status, headers });
	}

	return {
		async fetch(request) {
			const url = new URL(request.url);
			const target = resolveWithin(root, url.pathname);
			if (!target) return new Response('Not found.', { status: 404 });

			const direct = await respond(request, target, 200);
			if (direct) return direct;

			// The docs site is built with VitePress's `cleanUrls`, so /docs/intro is
			// really intro.html. Cloudflare resolves that with its default
			// `auto-trailing-slash` asset handling; this is the same rule. Without it
			// every docs page would fall through to the SPA shell below and render
			// the app's 404 instead.
			const asHtml = await respond(request, `${target}.html`, 200);
			if (asHtml) return asHtml;

			// Anything that looks like a file — /assets/app-abc123.js, a missing
			// image — is a genuine 404. Falling back to index.html for those would
			// hand a broken script tag an HTML document, and the failure surfaces as
			// a baffling syntax error rather than a missing file.
			if (extname(url.pathname)) return new Response('Not found.', { status: 404 });

			// Everything else is a client-side route: serve the SPA shell with a 200,
			// the same as the Worker's `not_found_handling: single-page-application`.
			const shell = await respond(request, join(root, 'index.html'), 200);
			return shell || new Response('Not found.', { status: 404 });
		},
	};
}
