// The API's tests run twice, in two runtimes, because the API is meant to run in
// two runtimes.
//
//   workers — everything, inside workerd (vitest.workers.config.js). This is the
//             hosted instance's runtime, and the only place the Durable Objects
//             and the R2/KV adapters can be exercised for real.
//   node    — the portable subset, under Node (vitest.node.config.js). What the
//             self-hosted instance runs on.
//
// Most files are in both. That overlap is the point rather than waste: a module
// that behaves differently across the two is a self-hosting bug, and the cheapest
// moment to find one is the moment it is introduced.

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: ['./vitest.workers.config.js', './vitest.node.config.js'],
	},
});
