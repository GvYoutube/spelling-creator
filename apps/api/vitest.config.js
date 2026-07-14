// Tests run inside the real Workers runtime (workerd) rather than Node, because the
// code under test uses runtime globals Node doesn't have — notably HTMLRewriter, which
// the rich-text sanitizer is built on (src/lib/richtext.js). Testing that against a
// Node-shaped fake would prove nothing about what actually runs in production.

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				miniflare: {
					compatibilityDate: '2026-05-28',
					compatibilityFlags: ['nodejs_compat'],
				},
			},
		},
	},
});
