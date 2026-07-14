// CollabRoom, exercised as a real Durable Object in workerd.
//
// The point of running it for real (rather than unit-testing the message handler
// against fakes) is that the things most likely to break are runtime behaviours:
// that Yjs merges correctly inside the room, that the merged state survives in
// SQLite well enough to hand to a late joiner, and that an update from one peer
// actually reaches the others. None of that is observable from a mock.
//
// These drive the DO stub directly, which bypasses handleCollab's Supabase JWT
// gate. That's deliberate: authentication is the Worker's job, not the room's.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

// Frame types — must match T in collab-room.js.
const T = { HELLO: 0, UPDATE: 1, PRESENCE: 4, ADMITTED: 5, ADMIT: 8 };

const decoder = new TextDecoder();

function frame(type, payload) {
	const b = new Uint8Array(1 + payload.length);
	b[0] = type;
	b.set(payload, 1);
	return b;
}

function slotFrame(type, slot) {
	const b = new Uint8Array(3);
	b[0] = type;
	b[1] = (slot >> 8) & 0xff;
	b[2] = slot & 0xff;
	return b;
}

// A connected participant: the socket, plus a queue so a test can await the next
// frame of a given type without racing the ones that arrive alongside it.
function participant(ws) {
	const queue = [];
	const waiting = [];
	ws.addEventListener('message', (ev) => {
		const bytes = new Uint8Array(ev.data);
		const next = waiting.shift();
		if (next) next(bytes);
		else queue.push(bytes);
	});

	const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve)));

	return {
		send: (bytes) => ws.send(bytes),
		async nextOf(type) {
			for (;;) {
				const f = await next();
				if (f[0] === type) return f;
			}
		},
		// Wait for a roster that actually contains someone awaiting admission (the
		// host also receives a roster when it connects, and again for every change).
		async nextRequest() {
			for (;;) {
				const f = await this.nextOf(T.PRESENCE);
				const roster = JSON.parse(decoder.decode(f.subarray(1)));
				if (roster.requests?.length) return roster.requests[0];
			}
		},
	};
}

async function connect(code, { create = false, uid = 'u', name = 'User', email = 'u@school.org' } = {}) {
	const stub = env.COLLAB_ROOM.get(env.COLLAB_ROOM.idFromName(code));
	const res = await stub.fetch(`https://collab/${code}${create ? '?create=1' : ''}`, {
		headers: {
			Upgrade: 'websocket',
			'X-Collab-Uid': uid,
			'X-Collab-Name': encodeURIComponent(name),
			'X-Collab-Email': encodeURIComponent(email),
			'X-Collab-Avatar': '',
		},
	});
	return { status: res.status, ws: res.webSocket };
}

async function join(code, opts) {
	const { status, ws } = await connect(code, opts);
	expect(status).toBe(101);
	ws.accept();
	return participant(ws);
}

// A Y.Doc shaped like a lesson, plus a tap on the updates it produces so a test
// can ship them over the wire the way the client does.
function peer() {
	const ydoc = new Y.Doc();
	const outbox = [];
	ydoc.on('update', (update, origin) => {
		if (origin !== 'remote') outbox.push(update);
	});
	return { ydoc, outbox };
}

function seed(ydoc) {
	const lesson = ydoc.getMap('lesson');
	ydoc.transact(() => {
		lesson.set('title', 'Week 1');
		const blocks = new Y.Array();
		const b1 = new Y.Map();
		b1.set('id', 'b1');
		b1.set('text', 'one');
		const b2 = new Y.Map();
		b2.set('id', 'b2');
		b2.set('text', 'two');
		blocks.push([b1, b2]);
		lesson.set('blocks', blocks);
	});
}

const read = (ydoc) => ydoc.getMap('lesson').toJSON();

// Set a block's text, and return the update that change produced.
function edit(p, blockId, text) {
	p.outbox.length = 0;
	const blocks = p.ydoc.getMap('lesson').get('blocks');
	for (const block of blocks) {
		if (block.get('id') === blockId) block.set('text', text);
	}
	return p.outbox[p.outbox.length - 1];
}

describe('CollabRoom', () => {
	it('refuses a code nobody is hosting', async () => {
		const { status } = await connect('empty-room');
		expect(status).toBe(404);
	});

	it('hands a newly admitted guest the lesson the host seeded', async () => {
		const host = await join('room-seed', { create: true, uid: 'host' });
		const hello = await host.nextOf(T.HELLO);
		expect(hello[3]).toBe(1); // role byte: host

		const hostPeer = peer();
		seed(hostPeer.ydoc);
		host.send(frame(T.UPDATE, Y.encodeStateAsUpdate(hostPeer.ydoc)));

		const guest = await join('room-seed', { uid: 'guest', email: 'g@school.org' });
		await guest.nextOf(T.HELLO);

		const pending = await host.nextRequest();
		expect(pending.email).toBe('g@school.org');
		host.send(slotFrame(T.ADMIT, pending.slot));

		// The room merged the host's seed and handed the whole document over.
		const admitted = await guest.nextOf(T.ADMITTED);
		const guestPeer = peer();
		Y.applyUpdate(guestPeer.ydoc, admitted.subarray(1), 'remote');

		expect(read(guestPeer.ydoc)).toEqual({
			title: 'Week 1',
			blocks: [
				{ id: 'b1', text: 'one' },
				{ id: 'b2', text: 'two' },
			],
		});
	});

	it('merges concurrent edits to different blocks and relays them', async () => {
		// The behaviour the whole migration exists for: under the old whole-document
		// last-write-wins relay, one of these two edits was silently lost.
		const host = await join('room-merge', { create: true, uid: 'host' });
		await host.nextOf(T.HELLO);

		const hostPeer = peer();
		seed(hostPeer.ydoc);
		host.send(frame(T.UPDATE, Y.encodeStateAsUpdate(hostPeer.ydoc)));

		const guest = await join('room-merge', { uid: 'guest', email: 'g@school.org' });
		await guest.nextOf(T.HELLO);
		const pending = await host.nextRequest();
		host.send(slotFrame(T.ADMIT, pending.slot));

		const admitted = await guest.nextOf(T.ADMITTED);
		const guestPeer = peer();
		Y.applyUpdate(guestPeer.ydoc, admitted.subarray(1), 'remote');

		// Each edits a different block, neither having seen the other's change.
		const hostUpdate = edit(hostPeer, 'b1', 'host edited');
		const guestUpdate = edit(guestPeer, 'b2', 'guest edited');
		host.send(frame(T.UPDATE, hostUpdate));
		guest.send(frame(T.UPDATE, guestUpdate));

		// Each receives the other's update from the room and merges it.
		Y.applyUpdate(guestPeer.ydoc, (await guest.nextOf(T.UPDATE)).subarray(1), 'remote');
		Y.applyUpdate(hostPeer.ydoc, (await host.nextOf(T.UPDATE)).subarray(1), 'remote');

		const expected = {
			title: 'Week 1',
			blocks: [
				{ id: 'b1', text: 'host edited' },
				{ id: 'b2', text: 'guest edited' },
			],
		};
		expect(read(hostPeer.ydoc)).toEqual(expected);
		expect(read(guestPeer.ydoc)).toEqual(expected);
	});

	it('gives a guest admitted later every edit made before they arrived', async () => {
		// Exercises the room's own merged state, not a replay of relayed traffic: the
		// late guest was not connected when any of these edits happened.
		const host = await join('room-late', { create: true, uid: 'host' });
		await host.nextOf(T.HELLO);

		const hostPeer = peer();
		seed(hostPeer.ydoc);
		host.send(frame(T.UPDATE, Y.encodeStateAsUpdate(hostPeer.ydoc)));
		host.send(frame(T.UPDATE, edit(hostPeer, 'b1', 'edited before you joined')));

		const guest = await join('room-late', { uid: 'late', email: 'late@school.org' });
		await guest.nextOf(T.HELLO);
		const pending = await host.nextRequest();
		host.send(slotFrame(T.ADMIT, pending.slot));

		const admitted = await guest.nextOf(T.ADMITTED);
		const guestPeer = peer();
		Y.applyUpdate(guestPeer.ydoc, admitted.subarray(1), 'remote');

		expect(read(guestPeer.ydoc).blocks[0].text).toBe('edited before you joined');
	});
});
