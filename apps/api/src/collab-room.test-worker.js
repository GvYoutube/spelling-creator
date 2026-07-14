// Test-only Worker entry. The CollabRoom tests drive the Durable Object directly
// through its stub, which requires the class to be exported from a Worker entry
// that Miniflare can load. The real entry (src/index.js) drags in Puppeteer,
// Supabase and the whole route table — none of which the room itself needs, and
// all of which would have to be stubbed to load it here.
//
// Driving the DO directly also deliberately bypasses handleCollab's Supabase JWT
// gate: authentication is the Worker's job, not the room's, so these tests are
// about the room's own behaviour (merging, relaying, admission, persistence).
export { CollabRoom } from './collab-room.js';

export default {
	fetch() {
		return new Response('collab-room test worker');
	},
};
