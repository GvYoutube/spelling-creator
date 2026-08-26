// Tests run inside the real Workers runtime (workerd) rather than Node, because the
// code under test uses runtime globals Node doesn't have — notably HTMLRewriter, which
// the rich-text sanitizer is built on (src/lib/richtext.js). Testing that against a
// Node-shaped fake would prove nothing about what actually runs in production.
//
// The same goes double for CollabRoom: it's a Durable Object holding the live session's
// Yjs document in SQLite and handing it to late joiners, so the only test worth having
// runs it as a real Durable Object. `main` points at a test-only entry exporting just
// that class (see src/collab-room.test-worker.js) — the production entry would drag in
// Puppeteer and the whole route table for no benefit.

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
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
