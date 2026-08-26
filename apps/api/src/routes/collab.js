// Live-collaboration WebSocket entry. We verify the Supabase JWT here (so only
// logged-in users reach the Durable Object and their identity is server-trusted),
// apply heavy connection rate limits, then forward the upgrade to the CollabRoom
// DO for that session code. The realtime relay lives in src/collab-room.js.

import { verifySupabaseUser } from '../lib/supabase.js';
import { displayNameOf } from '../lib/auth.js';
import { rateLimitStore } from '../platform/index.js';

/**
 * Live-collaboration WebSocket entry. A browser opens
 *   wss://<api>/collab/<code>?token=<jwt>[&create=1]
 * and we (1) verify the Supabase JWT here so only logged-in users ever reach the
 * Durable Object and their identity is server-trusted, (2) apply heavy connection
 * rate limits, then (3) forward the upgrade to the CollabRoom DO for that code,
 * passing the verified identity as headers. The realtime relay/admission logic
 * all lives in the DO (src/collab-room.js).
 */
export async function handleCollab(request, env, url, cors) {
	if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
		return new Response('Expected a WebSocket upgrade.', { status: 426, headers: cors });
	}
	if (!env.COLLAB_ROOM) {
		return new Response('Collaboration is not configured.', { status: 500, headers: cors });
	}

	const code = decodeURIComponent(url.pathname.slice('/collab/'.length)).trim();
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
		return new Response('Invalid session code.', { status: 400, headers: cors });
	}

	// Logged-in gate: a valid Supabase session is required. WebSockets can't set
	// an Authorization header from the browser, so the token rides in the query.
	const user = await verifySupabaseUser(env, url.searchParams.get('token') || '');
	if (!user) {
		return new Response('Sign in to collaborate.', { status: 401, headers: cors });
	}
	const create = url.searchParams.get('create') === '1';

	const kv = rateLimitStore(env);
	if (!kv) {
		return new Response('Server misconfiguration: no rate-limit store configured', { status: 500, headers: cors });
	}

	// Connection rate limit (token bucket): at most 5 joins/min per user.
	const JOIN_LIMIT = 5;
	const JOIN_WINDOW = 60;
	const now = Math.floor(Date.now() / 1000);
	const rlKey = `collab-rl:${user.id}`;
	const raw = await kv.get(rlKey);
	let entry = raw ? JSON.parse(raw) : { tokens: JOIN_LIMIT, last: now };
	entry.tokens = Math.min(JOIN_LIMIT, entry.tokens + ((now - entry.last) * JOIN_LIMIT) / JOIN_WINDOW);
	entry.last = now;
	if (entry.tokens < 1) {
		const retryAfter = Math.ceil((1 - entry.tokens) * (JOIN_WINDOW / JOIN_LIMIT));
		return new Response('Too many collaboration attempts. Please wait a moment.', {
			status: 429,
			headers: { ...cors, 'Retry-After': String(retryAfter) },
		});
	}
	entry.tokens -= 1;
	await kv.put(rlKey, JSON.stringify(entry), { expirationTtl: JOIN_WINDOW * 2 });

	// Concurrent-room cap: a user may host at most 6 live sessions at once. The
	// counter is incremented here on create and decremented by the DO when the
	// host disconnects; the TTL lets a leaked count self-heal.
	if (create) {
		const roomsKey = `collab-rooms:${user.id}`;
		const rooms = parseInt((await kv.get(roomsKey)) || '0', 10) || 0;
		if (rooms >= 6) {
			return new Response('You already have the maximum number of active collaboration sessions.', {
				status: 429,
				headers: cors,
			});
		}
		await kv.put(roomsKey, String(rooms + 1), { expirationTtl: 7200 });
	}

	// Forward the upgrade to the room's Durable Object with the verified identity.
	// Values are URL-encoded so non-ASCII display names survive HTTP headers.
	const name = displayNameOf(user) || (user.email ? user.email.split('@')[0] : '');
	const meta = user.user_metadata || {};
	const headers = new Headers(request.headers);
	headers.set('X-Collab-Uid', encodeURIComponent(user.id));
	headers.set('X-Collab-Name', encodeURIComponent(name));
	headers.set('X-Collab-Email', encodeURIComponent(user.email || ''));
	headers.set('X-Collab-Avatar', encodeURIComponent(meta.avatar_url || meta.picture || ''));

	const stub = env.COLLAB_ROOM.get(env.COLLAB_ROOM.idFromName(code));
	return stub.fetch(new Request(url.toString(), { method: 'GET', headers }));
}
