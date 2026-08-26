// The Node half of the suite.
//
// Most of this API is ordinary JavaScript over web-standard APIs — `fetch`,
// `Request`, `URL`, `crypto.subtle` — and only some of it needs the Workers
// runtime. Running the portable part under Node too is what turns "should be
// portable" into something checked: the sanitizer parses the same way, the S3
// signer signs the same way, and the codec loader reads its binaries off disk
// rather than getting them from wrangler's bundler.
//
// That last one is the case that can only be tested here. `#image-codec-wasm`
// resolves to a different module per runtime (see package.json), so the Workers
// project never loads the Node half at all — and without this project, nothing
// would notice it was broken until someone tried to upload an image to a
// self-hosted instance.
//
// Two suites are deliberately excluded rather than made to work here: the
// Cloudflare platform adapters, whose whole point is running against real R2 and
// KV, and CollabRoom, which is a Durable Object. Both live in the Workers
// project (vitest.workers.config.js), which is also where every suite listed
// here runs a second time.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		name: 'node',
		environment: 'node',
		include: ['src/**/*.test.js'],
		// The defaults are spread rather than replaced: `exclude` is not additive,
		// and the default list is what keeps node_modules out.
		exclude: [
			...configDefaults.exclude,
			// Runs against real R2/KV bindings via `cloudflare:test`.
			'src/platform/cloudflare.test.js',
			// A Durable Object; there is no Node equivalent to run it against.
			'src/collab-room.test.js',
		],
	},
});
