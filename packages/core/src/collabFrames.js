// The live-collaboration wire protocol, in one place.
//
// Three ends speak it: the room that relays (apps/api/src/collab-room.js), the
// browser that edits (apps/web/src/lib/collab.js), and the MCP server that joins
// a session on an assistant's behalf (apps/mcp/src/collab.js). Until this module
// existed the type bytes lived in the first two as separate copies joined by a
// comment reading "must match T in collab-room.js" — which is a convention, not
// a guarantee, and a third copy would have made it a coin toss. A renumbered
// frame is not a crash but a silent misread: the wrong branch of a switch, on a
// byte array nobody can eyeball.
//
// Frame shape is a type byte, then the payload. Cursor and chat payloads are
// UTF-8 JSON; document payloads are opaque Yjs update bytes, which the room can
// relay without parsing. Relayed frames (the ones the room fans out to everyone
// else) carry the sender's server-assigned u16 slot between the two, so a peer
// is identified by a number rather than by a name it asserts itself.
//
//   server -> client
//     HELLO    [0][slot u16][role u8]            your slot + role (1=host)
//     UPDATE   [1][yjs update]                    someone edited the document
//     CURSOR   [2][senderSlot u16][utf8 cursor]   where someone is editing
//     CHAT     [3][senderSlot u16][utf8 chat]     a chat message for everyone
//     PRESENCE [4][utf8 roster]                   who's here / who's waiting
//     ADMITTED [5][yjs state]                     you were added; here's the lesson
//     REMOVED  [6][utf8 reason]                   declined / removed / host left
//     ERROR    [7][utf8 message]                  fatal error before/while joining
//   client -> server
//     UPDATE   [1][yjs update]                     I edited the document
//     CURSOR   [2][utf8 cursor]                     my caret moved
//     CHAT     [3][utf8 chat]                       send a chat message
//     ADMIT    [8][targetSlot u16]                  host: add this pending guest
//     REMOVE   [9][targetSlot u16]                  host: decline / remove
//
// There is deliberately no separate "full document" frame: a Yjs update encoding
// an entire document is just a large update, and Y.applyUpdate treats it exactly
// like an incremental one. So the host's initial seed, a late joiner's ADMITTED
// payload and a single keystroke all travel the same path.

/** Frame type bytes. The wire format's only magic numbers. */
export const T = {
  HELLO: 0,
  UPDATE: 1,
  CURSOR: 2,
  CHAT: 3,
  PRESENCE: 4,
  ADMITTED: 5,
  REMOVED: 6,
  ERROR: 7,
  ADMIT: 8,
  REMOVE: 9,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A type byte followed by raw payload bytes. */
export function frameBytes(type, payload) {
  const body = payload || new Uint8Array(0);
  const b = new Uint8Array(1 + body.length);
  b[0] = type;
  b.set(body, 1);
  return b;
}

/** A type byte followed by a UTF-8 JSON payload. */
export function frameJson(type, obj) {
  return frameBytes(type, encoder.encode(JSON.stringify(obj)));
}

/** A type byte, a u16 slot, then payload bytes — the room's relayed frames. */
export function frameWithSlot(type, slot, payload) {
  const body = payload || new Uint8Array(0);
  const b = new Uint8Array(3 + body.length);
  b[0] = type;
  b[1] = (slot >> 8) & 0xff;
  b[2] = slot & 0xff;
  b.set(body, 3);
  return b;
}

/** A type byte and a u16 slot, with no payload — the host's admit/remove. */
export function slotFrame(type, slot) {
  return frameWithSlot(type, slot, null);
}

/** The frame's type byte, or null if there isn't one. */
export function frameType(view) {
  return view.length >= 1 ? view[0] : null;
}

/** The u16 slot a relayed frame carries at offset 1. */
export function readSlot(view) {
  return (view[1] << 8) | view[2];
}

/**
 * A frame's payload bytes, skipping the type byte and — when the frame is one
 * the room relays — the sender's slot.
 */
export function framePayload(view, { withSlot = false } = {}) {
  return view.subarray(withSlot ? 3 : 1);
}

/**
 * A frame's JSON payload, or null if it isn't parseable.
 *
 * Never throws: every one of these arrives from the network, and one malformed
 * cursor must not take down a session that is otherwise working.
 */
export function readJson(view, { withSlot = false } = {}) {
  try {
    return JSON.parse(decoder.decode(framePayload(view, { withSlot })));
  } catch {
    return null;
  }
}

/** A frame's UTF-8 text payload (REMOVED and ERROR carry a bare string). */
export function readText(view, { withSlot = false } = {}) {
  return decoder.decode(framePayload(view, { withSlot }));
}
