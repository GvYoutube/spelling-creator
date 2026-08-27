// The Node entry point — the same API, self-hosted.
//
//   node src/node/server.js
//
// It serves the route table from src/app.js, the built SPA from disk, and
// server-rendered HTML for the public read routes, against Postgres over
// PostgREST and an S3-compatible object store. What it does not serve is the
// three things that need Cloudflare specifically: live collaboration and the
// remote MCP endpoint (Durable Objects), and crawler prerendering plus og-image
// screenshots (Browser Rendering). See /monorepo/self-hosting for what that
// costs in practice — briefly, the MCP server still works over stdio, and SSR
// already covers the pages a crawler cares about.
//
// Configuration is environment variables and nothing else, listed in
// src/node/platform.js and in the docs. The process is stateless: run as many as
// you like behind a proxy.

import { pathToFileURL } from 'node:url';

import { serve } from '@hono/node-server';

import { createApp, registerFrontend } from '../app.js';
import { serverRender, shouldServerRender } from '../routes/ssr.js';
import { assetServer } from './assets.js';
import { nodePlatform } from './platform.js';

/**
 * The frontend fall-through for this host: server-render the public read routes,
 * and otherwise hand back the static asset.
 *
 * Deliberately not the Worker's `handleFrontend`, which is the same two steps
 * with headless-Chromium prerendering between them — importing it would pull
 * `@cloudflare/puppeteer` into a Node process that can never use it. The step
 * that is missing only ever applied to crawlers on "/", and SSR already covers
 * every other public page.
 */
async function frontend(request, env, ctx, url) {
	if (shouldServerRender(request, url)) {
		const rendered = await serverRender(request, env, ctx, url);
		if (rendered) return rendered;
	}
	return await env.ASSETS.fetch(request);
}

/**
 * Build the fetch handler, with the platform services and asset directory this
 * process was configured with.
 *
 * Exported and separated from listening so a test — or an embedding process —
 * can drive it without binding a port.
 *
 * @param {Record<string, string | undefined>} [processEnv]
 * @returns {(request: Request) => Promise<Response>}
 */
export function createHandler(processEnv = process.env) {
	const app = createApp();
	registerFrontend(app, frontend);

	// The Worker receives `env` from the runtime, already populated with bindings
	// and vars. Here it is the process environment plus the two things the runtime
	// would otherwise have supplied: the platform services and the asset server.
	const env = {
		...processEnv,
		PLATFORM: nodePlatform(processEnv),
		ASSETS: assetServer(processEnv.WEB_DIST || 'apps/web/dist'),
	};

	// `waitUntil` exists so a handler can finish background work after the response
	// is sent — populating a cache, mostly. There is no request lifetime to extend
	// in Node, so the work simply runs; what matters is that a rejection here
	// cannot become an unhandled rejection and take the process down.
	const ctx = {
		waitUntil(promise) {
			Promise.resolve(promise).catch((error) => {
				console.error('background task failed:', error);
			});
		},
		passThroughOnException() {},
	};

	return (request) => app.fetch(request, env, ctx);
}

/**
 * Ask every dependency whether it works, and print the answer.
 *
 * Run once the server is listening rather than before it, and never allowed to
 * stop it: a dependency that is still starting is normal in a container, and an
 * instance that refuses to serve because its object store was slow to come up
 * would be worse than one that says so and carries on.
 *
 * The point is that `docker compose logs app` answers "why doesn't the hub
 * work?" without anyone having to find an endpoint or a token first — which is
 * exactly what was missing the first time this was deployed.
 */
async function reportDependencies(env) {
	try {
		const { runDiagnostics, formatDiagnostics } = await import('../lib/diagnostics.js');
		const result = await runDiagnostics({ ...env, PLATFORM: nodePlatform(env) });
		(result.ok ? console.log : console.warn)(formatDiagnostics(result));
	} catch (e) {
		console.warn('Could not run the dependency check:', e);
	}
}

/** Start listening. Returns the server so a caller can close it. */
export function start(processEnv = process.env) {
	const port = Number(processEnv.PORT || 8787);
	const hostname = processEnv.HOST || '0.0.0.0';

	const fetch = createHandler(processEnv);
	const server = serve({ fetch, port, hostname }, (info) => {
		console.log(`Spelling Creator API listening on http://${hostname}:${info.port}`);
		// Deliberately after the listen callback and deliberately not awaited.
		void reportDependencies(processEnv);
	});

	// Containers and process managers stop a process with SIGTERM and expect it to
	// go quietly. Without this, Node ignores it while the server holds the event
	// loop open and the supervisor eventually escalates to SIGKILL — which drops
	// whatever requests were in flight.
	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.on(signal, () => {
			server.close(() => process.exit(0));
		});
	}
	return server;
}

// Started directly (`node src/node/server.js`) rather than imported by a test.
//
// Compared through pathToFileURL rather than by pasting `file://` onto the path:
// the two stop matching as soon as the path contains a space or a non-ASCII
// character, and the failure mode is that the process starts, exits 0, and
// serves nothing — which is a miserable thing to debug in a container.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
