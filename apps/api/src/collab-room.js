// CollabRoom — the server-authoritative coordinator for a live collaboration
// session, one Durable Object instance per session (addressed by the host's
// random share code via env.COLLAB_ROOM.idFromName(code)).
//
// This replaces the old PeerJS/WebRTC peer-to-peer relay (the host used to be
// the relay). Now every participant connects a single WebSocket to this DO,
// which is the authority and relay: it caches the current document, relays
// edits/cursors/chat between admitted collaborators, tracks presence, and routes
// the host's admit/remove decisions. The Worker (apps/api/src/index.js) verifies
// the Supabase JWT before any connection reaches here, so only logged-in users
// arrive and their identity (uid/name/email/avatar) is trusted server-side
// rather than self-asserted (the old metadata model was spoofable).
//
// Wire protocol — binary frames for speed. Every frame is an ArrayBuffer whose
// first byte is the message type; the rest is the payload. Document, cursor and
// chat payloads are UTF-8 JSON, which lets us relay the document bytes without
// parsing them. A sender is identified by a server-assigned u16 "slot" (not by
// name/email) — smaller packets and unspoofable. Frame shapes:
//
//   server -> client
//     HELLO    [0][slot u16][role u8]            your slot + role (1=host)
//     DOC      [1][utf8 doc]                      full document update
//     CURSOR   [2][senderSlot u16][utf8 cursor]   where someone is editing
//     CHAT     [3][senderSlot u16][utf8 chat]     a chat message for everyone
//     PRESENCE [4][utf8 roster]                   who's here / who's waiting
//     ADMITTED [5][utf8 doc]                      you were added; here's the doc
//     REMOVED  [6][utf8 reason]                   declined / removed / host left
//     ERROR    [7][utf8 message]                  fatal error before/while joining
//   client -> server
//     DOC      [1][utf8 doc]                       I edited the document
//     CURSOR   [2][utf8 cursor]                     my caret moved
//     CHAT     [3][utf8 chat]                       send a chat message
//     ADMIT    [8][targetSlot u16]                  host: add this pending guest
//     REMOVE   [9][targetSlot u16]                  host: decline / remove
import { DurableObject } from 'cloudflare:workers';

const T = {
	HELLO: 0,
	DOC: 1,
	CURSOR: 2,
	CHAT: 3,
	PRESENCE: 4,
	ADMITTED: 5,
	REMOVED: 6,
	ERROR: 7,
	ADMIT: 8,
	REMOVE: 9,
};

// Hard limits (the "strict" rate-limit profile). The Worker additionally caps
// how often a user may open a connection and how many rooms they may host; these
// are the per-room / per-connection caps enforced here.
const MAX_PARTICIPANTS = 10; // people in a single room (incl. host)
const MAX_DOC_BYTES = 512 * 1024; // a document update payload
const MAX_CURSOR_BYTES = 1024; // a cursor payload
const MAX_CHAT_BYTES = 8192; // a chat payload (~2000 UTF-8 chars)
// Per-connection message budgets, in messages per second (token-bucket).
const RATE = { [T.DOC]: 8, [T.CURSOR]: 15, [T.CHAT]: 2 };
// Close a connection that keeps exceeding its budget this many times — a sender
// that ignores back-pressure is treated as abusive rather than throttled forever.
const MAX_VIOLATIONS = 100;

const enc = new TextEncoder();

// ----- binary frame builders ------------------------------------------------
function frameHello(slot, host) {
	const b = new Uint8Array(4);
	b[0] = T.HELLO;
	b[1] = (slot >> 8) & 0xff;
	b[2] = slot & 0xff;
	b[3] = host ? 1 : 0;
	return b;
}

// A type byte followed by raw payload bytes (used for DOC/ADMITTED/REMOVED/ERROR).
function frameBytes(type, payload) {
	const b = new Uint8Array(1 + payload.length);
	b[0] = type;
	b.set(payload, 1);
	return b;
}

function frameJson(type, obj) {
	return frameBytes(type, enc.encode(JSON.stringify(obj)));
}

// A type byte, a sender slot (u16), then the payload bytes (CURSOR/CHAT relay).
function frameWithSlot(type, slot, payload) {
	const b = new Uint8Array(3 + payload.length);
	b[0] = type;
	b[1] = (slot >> 8) & 0xff;
	b[2] = slot & 0xff;
	b.set(payload, 3);
	return b;
}

export class CollabRoom extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx = ctx;
		this.env = env;
		// Per-connection message-rate buckets and violation counts, keyed by slot.
		// In-memory only: if the DO is evicted while sockets hibernate these reset,
		// which is lenient (a fresh full bucket) on the next message — acceptable.
		this.buckets = new Map();
		this.violations = new Map();
		// The document is cached in SQLite (not a DO storage value) so it survives
		// hibernation/eviction and can exceed the 128 KiB key-value limit; a late
		// joiner is served the cached copy on admission.
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room (k TEXT PRIMARY KEY, v BLOB)');
		});
		// Keep-alive. A backgrounded tab stops sending cursor/doc traffic, so its
		// otherwise-idle WebSocket gets dropped as inactive — the bug where leaving
		// the tab ends the session. Browsers can't send protocol-level ping frames
		// from JS, so the client sends a "ping" text message on a timer (see
		// collab.js) and the runtime answers "pong" here automatically — without
		// waking this object from hibernation — which keeps the connection alive.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	// ----- document cache (SQLite) -------------------------------------------
	getDocBytes() {
		const rows = this.ctx.storage.sql.exec("SELECT v FROM room WHERE k = 'doc'").toArray();
		const v = rows[0]?.v;
		return v ? new Uint8Array(v) : null;
	}

	setDocBytes(bytes) {
		// Bind a standalone ArrayBuffer (the source is usually a subarray view of a
		// larger frame; copying avoids any ambiguity over byteOffset when SQLite
		// stores the BLOB).
		const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		this.ctx.storage.sql.exec("INSERT OR REPLACE INTO room (k, v) VALUES ('doc', ?)", buf);
	}

	// ----- connection helpers -------------------------------------------------
	state(ws) {
		return ws.deserializeAttachment() || null;
	}

	hostSocket() {
		for (const ws of this.ctx.getWebSockets()) {
			const s = this.state(ws);
			if (s && s.host) return ws;
		}
		return null;
	}

	socketBySlot(slot) {
		for (const ws of this.ctx.getWebSockets()) {
			const s = this.state(ws);
			if (s && s.slot === slot) return ws;
		}
		return null;
	}

	// The next free slot: one past the highest currently-connected slot. Derived
	// from live sockets (not a counter) so it stays correct across hibernation.
	nextSlot() {
		let max = -1;
		for (const ws of this.ctx.getWebSockets()) {
			const s = this.state(ws);
			if (s && s.slot > max) max = s.slot;
		}
		return max + 1;
	}

	send(ws, frame) {
		try {
			ws.send(frame);
		} catch {
			/* a socket mid-close; its close handler will clean it up */
		}
	}

	// ----- presence -----------------------------------------------------------
	// Publish the roster. The host sees both the admitted participants and the
	// pending requests; admitted guests see only the participant list (a non-empty
	// list is their signal they're in the lesson). Pending guests get nothing yet.
	broadcastPresence() {
		const participants = [];
		const requests = [];
		for (const ws of this.ctx.getWebSockets()) {
			const s = this.state(ws);
			if (!s) continue;
			const entry = {
				slot: s.slot,
				name: s.name,
				email: s.email,
				avatarUrl: s.avatarUrl,
				host: s.host,
			};
			if (s.admitted) participants.push(entry);
			else requests.push(entry);
		}
		participants.sort((a, b) => (a.host ? -1 : b.host ? 1 : a.slot - b.slot));
		const hostFrame = frameJson(T.PRESENCE, { participants, requests });
		const guestFrame = frameJson(T.PRESENCE, { participants, requests: [] });
		for (const ws of this.ctx.getWebSockets()) {
			const s = this.state(ws);
			if (!s) continue;
			if (s.host) this.send(ws, hostFrame);
			else if (s.admitted) this.send(ws, guestFrame);
		}
	}

	// ----- rate limiting ------------------------------------------------------
	// Token-bucket check for one message of `type` from `slot`. Returns true if
	// the message is within budget. Sustained over-budget traffic trips a
	// violation counter that eventually closes the socket.
	rateOk(slot, type) {
		const perSec = RATE[type];
		if (!perSec) return true;
		let b = this.buckets.get(slot);
		if (!b) {
			b = {};
			this.buckets.set(slot, b);
		}
		const now = Date.now();
		let s = b[type];
		if (!s) {
			s = { tokens: perSec, last: now };
			b[type] = s;
		}
		s.tokens = Math.min(perSec, s.tokens + ((now - s.last) / 1000) * perSec);
		s.last = now;
		if (s.tokens < 1) {
			this.violations.set(slot, (this.violations.get(slot) || 0) + 1);
			return false;
		}
		s.tokens -= 1;
		return true;
	}

	abusive(slot) {
		return (this.violations.get(slot) || 0) > MAX_VIOLATIONS;
	}

	// ----- connection lifecycle ----------------------------------------------
	async fetch(request) {
		if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade.', { status: 426 });
		}
		const url = new URL(request.url);
		const create = url.searchParams.get('create') === '1';
		// Identity is supplied by the Worker from the verified Supabase user, URL-
		// encoded so non-ASCII names survive an HTTP header.
		const dec = (h) => {
			try {
				return decodeURIComponent(request.headers.get(h) || '');
			} catch {
				return '';
			}
		};
		const uid = dec('X-Collab-Uid');
		const identity = {
			name: dec('X-Collab-Name'),
			email: dec('X-Collab-Email'),
			avatarUrl: dec('X-Collab-Avatar'),
		};

		const existingHost = this.hostSocket();
		let host = false;
		if (create && !existingHost) {
			host = true;
		} else if (!existingHost) {
			// Joining a code that nobody is hosting — mirrors the old "no session for
			// that code" failure when a PeerJS host id wasn't found.
			return new Response('Session not found', { status: 404 });
		}

		if (this.ctx.getWebSockets().length >= MAX_PARTICIPANTS) {
			return new Response('This session is full.', { status: 403 });
		}

		const slot = this.nextSlot();
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({
			slot,
			uid,
			name: identity.name,
			email: identity.email,
			avatarUrl: identity.avatarUrl,
			host,
			admitted: host, // the host is implicitly part of their own lesson
		});

		this.send(server, frameHello(slot, host));
		this.broadcastPresence();

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws, message) {
		const bytes = typeof message === 'string' ? enc.encode(message) : new Uint8Array(message);
		if (bytes.length < 1) return;
		const s = this.state(ws);
		if (!s) return;
		const type = bytes[0];
		const payload = bytes.subarray(1);

		// Per-connection flood control for the relayed message types.
		if (type === T.DOC || type === T.CURSOR || type === T.CHAT) {
			if (!this.rateOk(s.slot, type)) {
				if (this.abusive(s.slot)) {
					try {
						ws.close(1008, 'Rate limit exceeded.');
					} catch {
						/* ignore */
					}
				}
				return; // drop the over-budget frame
			}
		}

		switch (type) {
			case T.DOC: {
				if (!s.admitted) return;
				if (payload.length > MAX_DOC_BYTES) return;
				// Cache the new document and relay it to every *other* admitted peer.
				this.setDocBytes(payload);
				const frame = frameBytes(T.DOC, payload);
				this.relay(s.slot, frame, true);
				break;
			}
			case T.CURSOR: {
				if (!s.admitted || payload.length > MAX_CURSOR_BYTES) return;
				// Stamp the sender's slot server-side so a peer can't spoof whose caret
				// it is, then relay to the other admitted peers.
				this.relay(s.slot, frameWithSlot(T.CURSOR, s.slot, payload), true);
				break;
			}
			case T.CHAT: {
				if (!s.admitted || payload.length > MAX_CHAT_BYTES) return;
				this.relay(s.slot, frameWithSlot(T.CHAT, s.slot, payload), true);
				break;
			}
			case T.ADMIT: {
				if (!s.host || payload.length < 2) return;
				this.admit((payload[0] << 8) | payload[1]);
				break;
			}
			case T.REMOVE: {
				if (!s.host || payload.length < 2) return;
				this.removeBySlot((payload[0] << 8) | payload[1]);
				break;
			}
			default:
				break;
		}
	}

	// Relay a prepared frame to admitted peers other than the sender.
	relay(senderSlot, frame, admittedOnly) {
		for (const ws of this.ctx.getWebSockets()) {
			const s = this.state(ws);
			if (!s || s.slot === senderSlot) continue;
			if (admittedOnly && !s.admitted) continue;
			this.send(ws, frame);
		}
	}

	// Host admitted a pending guest: flip them to admitted, hand them the cached
	// document, and refresh everyone's roster.
	admit(slot) {
		const ws = this.socketBySlot(slot);
		if (!ws) return;
		const s = this.state(ws);
		if (!s || s.admitted) return;
		s.admitted = true;
		ws.serializeAttachment(s);
		const doc = this.getDocBytes() || new Uint8Array(0);
		this.send(ws, frameBytes(T.ADMITTED, doc));
		this.broadcastPresence();
	}

	// Host declined a pending guest or removed a collaborator.
	removeBySlot(slot) {
		const ws = this.socketBySlot(slot);
		if (!ws) return;
		const s = this.state(ws);
		if (!s || s.host) return; // the host can't remove themselves this way
		this.send(ws, frameBytes(T.REMOVED, enc.encode('removed')));
		try {
			ws.close(1000, 'removed');
		} catch {
			/* the close handler runs the cleanup either way */
		}
	}

	async webSocketClose(ws) {
		await this.onGone(ws);
	}

	async webSocketError(ws) {
		await this.onGone(ws);
	}

	// A connection went away. Forget its rate-limit state; if the host left, end
	// the session for everyone and release the host's room slot; otherwise just
	// refresh presence.
	async onGone(ws) {
		const s = this.state(ws);
		if (s) {
			this.buckets.delete(s.slot);
			this.violations.delete(s.slot);
		}
		if (s && s.host) {
			const bye = frameBytes(T.REMOVED, enc.encode('The host ended the session.'));
			for (const other of this.ctx.getWebSockets()) {
				if (other === ws) continue;
				this.send(other, bye);
				try {
					other.close(1000, 'host left');
				} catch {
					/* ignore */
				}
			}
			this.ctx.storage.sql.exec("DELETE FROM room WHERE k = 'doc'");
			await this.releaseRoom(s.uid);
		} else {
			this.broadcastPresence();
		}
	}

	// Best-effort decrement of the host's concurrent-room counter that the Worker
	// incremented when the session was created.
	async releaseRoom(uid) {
		if (!uid || !this.env.RATE_LIMIT_KV) return;
		try {
			const key = `collab-rooms:${uid}`;
			const n = parseInt((await this.env.RATE_LIMIT_KV.get(key)) || '0', 10) || 0;
			if (n <= 1) await this.env.RATE_LIMIT_KV.delete(key);
			else await this.env.RATE_LIMIT_KV.put(key, String(n - 1), { expirationTtl: 7200 });
		} catch {
			/* best-effort; the TTL lets a stale count expire on its own */
		}
	}
}
