// The Node entry, driven as a handler rather than over a socket.
//
// `createHandler` is separated from `start` for exactly this: the interesting
// question is whether a request routed through the shared app reaches the right
// place on this host, and binding a port to find out would make the test slower
// and flakier without answering anything extra.
//
// What is worth pinning down here is the wiring, not the routes — those are the
// same objects the Worker serves and are tested where they live. So: that the
// asset server behaves the way `env.ASSETS` did, that a client cannot forge the
// IP that bans are applied to, and that an unconfigured store degrades instead
// of crashing.
//
// Importing `createHandler` pulls in routes/ssr.js, whose import of the built
// server bundle is deliberately static — so this file cannot run until
// apps/web has been built. That is why `test` builds it first, the same way
// `dev`, `start` and `deploy` in this package already do.

import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { assetServer } from './assets.js';
import { nodePlatform } from './platform.js';
import { createHandler } from './server.js';

/** A directory shaped like a built apps/web/dist. */
async function buildFixture() {
	const root = await mkdtemp(join(tmpdir(), 'spelling-assets-'));
	await writeFile(join(root, 'index.html'), '<!doctype html><title>shell</title>');
	await mkdir(join(root, 'assets'), { recursive: true });
	await writeFile(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
	await mkdir(join(root, 'docs'), { recursive: true });
	await writeFile(join(root, 'docs', 'index.html'), '<!doctype html><title>docs</title>');
	await writeFile(join(root, 'docs', 'intro.html'), '<!doctype html><title>intro</title>');
	return root;
}

describe('assetServer', () => {
	let assets;
	beforeAll(async () => {
		assets = assetServer(await buildFixture());
	});

	const get = (path, init) => assets.fetch(new Request(`https://host.test${path}`, init));

	it('serves a file with its content type', async () => {
		const res = await get('/assets/app-abc123.js');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/javascript');
		expect(await res.text()).toBe('console.log(1)');
	});

	it('caches hashed assets forever and the shell never', async () => {
		// Vite writes hashed filenames, so those bytes never change for a URL. The
		// shell must revalidate or a deploy leaves browsers pointing at asset names
		// that no longer exist.
		expect((await get('/assets/app-abc123.js')).headers.get('cache-control')).toContain('immutable');
		expect((await get('/')).headers.get('cache-control')).toBe('no-cache');
	});

	it('types a directory index by the file it resolved, not the path asked for', async () => {
		// "/" resolves to index.html. Typing it by the requested path gives
		// application/octet-stream, which browsers offer to download.
		const res = await get('/');
		expect(res.headers.get('content-type')).toContain('text/html');
	});

	it('serves the SPA shell for a client-side route', async () => {
		const res = await get('/hub/some-lesson-id');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('shell');
	});

	it('404s a missing file rather than handing it the shell', async () => {
		// A broken script tag given an HTML document surfaces as a baffling syntax
		// error instead of a missing file.
		const res = await get('/assets/gone-000000.js');
		expect(res.status).toBe(404);
	});

	it('resolves a clean docs URL to its .html file', async () => {
		// VitePress `cleanUrls`; Cloudflare does this with auto-trailing-slash.
		expect(await (await get('/docs/intro')).text()).toContain('intro');
		expect(await (await get('/docs/')).text()).toContain('docs');
	});

	it('refuses to escape the asset directory', async () => {
		// The encoded spelling is the one that matters. A literal `/../..` never
		// reaches the server as traversal — the URL parser collapses it, so that
		// request arrives as an ordinary path and correctly gets the SPA shell.
		// Percent-encoded, it only becomes traversal after decoding, which is why
		// the containment check has to happen on the decoded path.
		expect((await get('/..%2f..%2f..%2fetc%2fpasswd')).status).toBe(404);
		expect((await get('/%2e%2e%2f%2e%2e%2fpackage.json')).status).toBe(404);
	});

	it('refuses to follow a symlink out of the asset directory', async () => {
		// The lexical containment check passes for a link inside the directory —
		// its path is inside — while its contents are anywhere the link points. A
		// build step or an unpacked archive can leave one behind, and without the
		// real-path check the process serves whatever it can read.
		const root = await mkdtemp(join(tmpdir(), 'spelling-symlink-'));
		const outside = await mkdtemp(join(tmpdir(), 'spelling-outside-'));
		await writeFile(join(root, 'index.html'), '<!doctype html><title>shell</title>');
		await writeFile(join(outside, 'secret.txt'), 'not yours');
		await symlink(join(outside, 'secret.txt'), join(root, 'secret.txt'));
		await symlink(outside, join(root, 'elsewhere'));

		const server = assetServer(root);
		const fetchPath = (path) => server.fetch(new Request(`https://host.test${path}`));
		expect((await fetchPath('/secret.txt')).status).toBe(404);
		expect((await fetchPath('/elsewhere/secret.txt')).status).toBe(404);
		// A file that really is inside still works, including through a link that
		// stays within the directory — the check is where the bytes are, not
		// whether a link was involved.
		await symlink(join(root, 'index.html'), join(root, 'shell.html'));
		expect((await fetchPath('/shell.html')).status).toBe(200);
	});

	it('answers HEAD with headers and no body', async () => {
		const res = await get('/assets/app-abc123.js', { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe('14');
		expect(await res.text()).toBe('');
	});
});

describe('nodePlatform', () => {
	it('leaves a store null when it is unconfigured', () => {
		// The same thing an absent Cloudflare binding means, and the routes already
		// handle it — an instance with no bucket serves the hub and refuses uploads.
		const platform = nodePlatform({});
		expect(platform.images).toBe(null);
		expect(platform.lessonGit).toBe(null);
		expect(platform.rateLimit).toBe(null);
		expect(platform.cache).toBeTruthy();
	});

	it('builds both buckets from one set of credentials', () => {
		const platform = nodePlatform({
			S3_ENDPOINT: 'http://minio:9000',
			S3_ACCESS_KEY_ID: 'k',
			S3_SECRET_ACCESS_KEY: 's',
			S3_BUCKET_IMAGES: 'images',
			S3_BUCKET_GIT: 'git',
		});
		expect(typeof platform.images.get).toBe('function');
		expect(typeof platform.lessonGit.get).toBe('function');
	});

	describe('clientIp', () => {
		const ipFor = (env, headers) => nodePlatform(env).clientIp(new Request('https://host.test/', { headers }));

		it('reads the entry the nearest proxy added, not the first', () => {
			// The client controls the left of x-forwarded-for. Reading it — the usual
			// mistake — lets any caller forge the IP that bans are keyed on.
			expect(ipFor({}, { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })).toBe('3.3.3.3');
		});

		it('counts back further when more proxies are trusted', () => {
			expect(ipFor({ TRUSTED_PROXY_COUNT: '2' }, { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })).toBe('2.2.2.2');
		});

		it('never indexes off the front of a short list', () => {
			// More trusted hops than entries means something is misconfigured; the
			// answer should be the oldest entry, not undefined.
			expect(ipFor({ TRUSTED_PROXY_COUNT: '9' }, { 'x-forwarded-for': '1.1.1.1' })).toBe('1.1.1.1');
		});

		it('trusts nothing when no proxy is declared', () => {
			// A directly-exposed process has no hop that wrote the header, so every
			// entry in it is the caller's. Believing any of them would let a banned
			// user pick the address the ban is keyed on.
			expect(ipFor({ TRUSTED_PROXY_COUNT: '0' }, { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })).toBe('');
			expect(ipFor({ TRUSTED_PROXY_COUNT: '0', CLIENT_IP_HEADER: 'x-real-ip' }, { 'x-real-ip': '4.4.4.4' })).toBe('');
		});

		it('keeps the default when the setting is blank or nonsense', () => {
			// Only a literal 0 turns the header off; a typo falls back to one proxy
			// rather than to trusting nothing (or, worse, to trusting the client).
			const xff = { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' };
			expect(ipFor({ TRUSTED_PROXY_COUNT: '' }, xff)).toBe('2.2.2.2');
			expect(ipFor({ TRUSTED_PROXY_COUNT: 'two' }, xff)).toBe('2.2.2.2');
			expect(ipFor({ TRUSTED_PROXY_COUNT: '-1' }, xff)).toBe('2.2.2.2');
		});

		it('takes a single-value header whole', () => {
			expect(ipFor({ CLIENT_IP_HEADER: 'x-real-ip' }, { 'x-real-ip': '4.4.4.4' })).toBe('4.4.4.4');
		});

		it('is empty when the header is absent', () => {
			expect(ipFor({}, {})).toBe('');
		});
	});
});

describe('createHandler', () => {
	let handler;
	beforeAll(async () => {
		handler = createHandler({ WEB_DIST: await buildFixture(), ALLOWED_HOSTNAMES: 'host.test' });
	});

	it('serves the SPA for an unmatched GET', async () => {
		const res = await handler(new Request('https://host.test/hub'));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('shell');
	});

	it('answers a CORS preflight without touching a route', async () => {
		const res = await handler(new Request('https://host.test/lessons', { method: 'OPTIONS' }));
		expect(res.status).toBe(204);
	});

	it('reports a missing store rather than crashing', async () => {
		// No S3 configured in this fixture. The route has to say so, not throw:
		// a half-configured instance should still serve everything else.
		const res = await handler(new Request('https://host.test/images/' + 'a'.repeat(64)));
		expect(res.status).toBe(500);
		expect(await res.text()).toContain('not configured');
	});

	it('does not serve the Cloudflare-only routes', async () => {
		// Live collaboration is a Durable Object. Rather than 500 halfway through a
		// WebSocket upgrade, the route simply is not registered — so this falls to
		// the SPA catch-all, which is a page saying the app exists.
		const res = await handler(new Request('https://host.test/collab/abc'));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('shell');
	});
});
