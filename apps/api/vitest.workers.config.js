// Tests run inside the real Workers runtime (workerd) rather than Node, because
// some of the code under test only exists there.
//
// That used to include the rich-text sanitizer, which was built on HTMLRewriter; it
// parses with parse5 now and would run anywhere. What still pins this to workerd is
// the platform adapters — src/platform/cloudflare.test.js runs the conformance suite
// against real R2 and KV, and a Node-shaped fake of those would only assert our own
// assumptions back at us.
//
// The same goes double for CollabRoom: it's a Durable Object holding the live session's
// Yjs document in SQLite and handing it to late joiners, so the only test worth having
// runs it as a real Durable Object. `main` points at a test-only entry exporting just
// that class (see src/collab-room.test-worker.js) — the production entry would drag in
// Puppeteer and the whole route table for no benefit.

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';

export default defineWorkersConfig({
	test: {
		name: 'workers',
		// Image conversion runs in the Node project only, which is a limitation of
		// this runner rather than a gap in the code. Its codecs arrive as `.wasm`
		// imports from a dependency, and vitest-pool-workers cannot resolve one out
		// of node_modules — it uses Vite's module graph, not wrangler's bundler.
		//
		// So a pass here would not have said much about production either way: what
		// actually has to resolve those imports is `wrangler deploy`, and CI checks
		// that directly by bundling the Worker (`pnpm --filter @spelling-creator/api
		// bundle`). The half of the loader that only Node runs is covered by the
		// Node project, which is the half that had no coverage at all before.
		//
		// Spread the defaults rather than replacing them: `exclude` is not additive,
		// and vitest's default list is what keeps node_modules out. Dropping it
		// hands the runner every test file in every installed dependency.
		include: ['src/**/*.test.js'],
		exclude: [
			...configDefaults.exclude,
			'src/imageConvert.test.js',
			// The Node entry point and its filesystem-backed asset server. There is
			// nothing here for workerd to run — this host is the other one.
			'src/node/**',
		],
		poolOptions: {
			workers: {
				main: './src/collab-room.test-worker.js',
				// Isolated storage (a per-test storage stack) can't unwind a Durable Object
				// that still holds open WebSockets — it fails on the room's SQLite journal.
				// The collab tests each use their own room code, so they don't need it.
				isolatedStorage: false,
				miniflare: {
					compatibilityDate: '2026-05-28',
					compatibilityFlags: ['nodejs_compat'],
					durableObjects: {
						COLLAB_ROOM: { className: 'CollabRoom', useSQLite: true },
					},
					// A bucket and a namespace for the platform-adapter conformance suite
					// (src/platform/cloudflare.test.js) to run against. Deliberately not
					// named after the production bindings: these exist to exercise the
					// adapters, and reusing IMAGES/RATE_LIMIT_KV here would invite a test
					// to reach for a binding instead of the seam in front of it.
					r2Buckets: ['TEST_BLOBS'],
					kvNamespaces: ['TEST_KV'],
				},
			},
		},
	},
});
