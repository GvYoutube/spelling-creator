// A headless participant in a live collaboration session.
//
// The web app joins a room from a React hook (apps/web/src/lib/collab.js); this
// is the same protocol with no browser and no UI, so an assistant can be a peer
// in a session a teacher is running. It holds one WebSocket, mirrors the room's
// Y.Doc, and exposes the document as the plain JSON every other tool in this
// server already speaks.
//
// Why a session at all, when this server can already read and write lessons over
// the API: because a live session is where the *unsaved* lesson is. The document
// in a room exists only in the room until somebody saves it, so the hub's copy is
// whatever it was before the session started. Editing through the API while a
// teacher has the lesson open in a session writes to the wrong document, and
// their next save overwrites it.
//
// The other half is that a room is bidirectional. An API write is a statement; a
// room is a conversation — the assistant's edits appear under a cursor of their
// own, the teacher watches them land, and CHAT is a channel for asking rather
// than guessing.
//
// Three properties of the room the design leans on:
//
//   • Admission is the host's. A joining participant waits until the teacher
//     admits them, so nothing here can put an assistant into a session
//     uninvited. That is the consent gate, and it already existed.
//   • Edits merge. The room is a CRDT, so an assistant writing section 3 while
//     the teacher writes section 5 costs neither of them their work. What does
//     NOT merge is the same *field* — reconcile stores text as a plain string
//     (see core/ydoc.js), so two writers in one paragraph is still
//     last-write-wins. Hence editBlocks() below refuses a block someone else's
//     caret is sitting in.
//   • Removal is instant. The host can eject a participant mid-thought, which is
//     a better stop button than anything a tool call could offer.

import * as Y from "yjs";

import {
  T,
  frameBytes,
  frameJson,
  frameType,
  framePayload,
  readJson,
  readSlot,
  readText,
} from "@spelling-creator/core/collabFrames";
import {
  REMOTE,
  applyRemote,
  docFromY,
  reconcile,
} from "@spelling-creator/core/ydoc";

// How long to wait for the host to admit us before giving up. Generous, because
// the teacher has to notice the request and click: this is a person's reaction
// time, not a network round trip. The tool tells the model to expect the wait.
const ADMIT_TIMEOUT_MS = 120_000;
// How long to wait for the socket itself, which is a network round trip.
const CONNECT_TIMEOUT_MS = 15_000;
// The room drops an idle socket, and unlike a browser we have no user generating
// traffic. The room auto-answers a text "ping" without even waking from
// hibernation (see setWebSocketAutoResponse in collab-room.js).
const PING_MS = 20_000;
// The room's own per-connection budget is 2 chat messages a second. An assistant
// has no business anywhere near that, and one that loops would otherwise burn
// through the violation counter and get the socket closed under it.
const CHAT_MIN_GAP_MS = 1_000;

/** Whether this runtime can open a WebSocket at all. */
export function canJoinSessions() {
  return typeof globalThis.WebSocket === "function";
}

/**
 * The advice a runtime without WebSocket gets. Node grew a global WebSocket in
 * v21 and stabilised it in v22; this server otherwise supports v18, so rather
 * than take a dependency on `ws` for one optional feature, the feature says what
 * it needs. Everything else in the server works regardless.
 */
export const NO_WEBSOCKET =
  "This Node version has no WebSocket support, so live collaboration sessions can't be joined. " +
  "Node 22 or newer is needed (v21 has it behind a flag). Everything else in this server works as normal — " +
  "you can still read and edit lessons through the hub with get_lesson and patch_lesson.";

/**
 * Join a room and stay in it.
 *
 * Resolves once the host has admitted us and the lesson has arrived; rejects if
 * the room refuses, the host declines, or nobody answers in time. The returned
 * session stays live until close() or until the room ends it.
 *
 * @param {object} opts
 * @param {string} opts.url        wss://…/collab/<code>?token=…
 * @param {string} opts.code       The share code, for messages.
 * @returns {Promise<CollabSession>}
 */
export function joinSession({ url, code }) {
  if (!canJoinSessions()) return Promise.reject(new Error(NO_WEBSOCKET));

  const ydoc = new Y.Doc();
  const state = {
    code,
    slot: null,
    admitted: false,
    roster: [],
    // Chat we've been sent since the last read, oldest first. Drained rather
    // than accumulated forever: a long session would otherwise grow without
    // bound in a process nobody is watching.
    chat: [],
    // Where each peer's caret is, by slot — how editBlocks() knows which blocks
    // are somebody else's to edit.
    cursors: new Map(),
    closed: false,
    closedReason: null,
    lastChatAt: 0,
  };

  const ws = new globalThis.WebSocket(url);
  ws.binaryType = "arraybuffer";

  // Every timer this session owns, so closing it can drop all of them. They are
  // held out here rather than beside the promise that arms them because a
  // session that fails to join must not leave the two-minute admission timer
  // ticking: node keeps a process alive for a pending timer, so a declined join
  // would otherwise stop the whole MCP server exiting until it fired.
  const timers = { ping: null, connect: null, admit: null };
  const clearTimers = () => {
    if (timers.ping) clearInterval(timers.ping);
    if (timers.connect) clearTimeout(timers.connect);
    if (timers.admit) clearTimeout(timers.admit);
    timers.ping = timers.connect = timers.admit = null;
  };

  const stop = (reason) => {
    if (state.closed) return;
    state.closed = true;
    state.closedReason = reason;
    clearTimers();
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  };

  const session = {
    get code() {
      return state.code;
    },
    get closed() {
      return state.closed;
    },
    get closedReason() {
      return state.closedReason;
    },
    /** Everyone the room says is in the session, the assistant included. */
    get participants() {
      return state.roster;
    },

    /** The lesson as the room currently holds it, as plain JSON. */
    doc() {
      return docFromY(ydoc);
    },

    /**
     * Which blocks another participant's caret is in right now.
     *
     * The CRDT merges edits to different fields but not to the same one, so this
     * is what stops an assistant overwriting the sentence a teacher is midway
     * through typing. Cursors are advisory and go stale, which is why this is
     * consulted at the moment of the edit rather than cached.
     */
    busyBlocks() {
      const busy = new Map();
      for (const [slot, cursor] of state.cursors) {
        if (slot === state.slot || !cursor?.field) continue;
        const who = state.roster.find((p) => p.slot === slot);
        busy.set(cursor.field, who?.name || `participant ${slot}`);
      }
      return busy;
    },

    /**
     * Apply a change to the shared document.
     *
     * `mutate` receives the plain doc and returns the one it should become; the
     * difference is reconciled into the Y.Doc, which emits exactly one update,
     * which the room relays. Going through reconcile rather than writing Y types
     * directly is what keeps this identical to an edit made in the browser.
     */
    edit(mutate) {
      const next = mutate(docFromY(ydoc));
      reconcile(ydoc, next);
      return docFromY(ydoc);
    },

    /** Say something in the session's chat. */
    say(textBody) {
      const now = Date.now();
      if (now - state.lastChatAt < CHAT_MIN_GAP_MS) {
        throw new Error(
          "Too many chat messages too quickly. The room allows about one a second, and a participant that " +
            "ignores that gets disconnected — wait before sending another.",
        );
      }
      state.lastChatAt = now;
      send(frameJson(T.CHAT, { text: textBody, ts: now }));
    },

    /** Chat received since the last call, oldest first. */
    drainChat() {
      const out = state.chat;
      state.chat = [];
      return out;
    },

    close(reason = "left") {
      stop(reason);
    },
  };

  function send(bytes) {
    if (state.closed) throw new Error(leftMessage(state));
    try {
      ws.send(bytes);
    } catch {
      throw new Error("The connection to the session dropped mid-send.");
    }
  }

  // Our own edits have to reach the room; edits we receive must not be echoed
  // straight back. Yjs tags each update with the origin of the transaction that
  // produced it, which is the whole basis of the loop terminating — see the
  // comment at the top of core/ydoc.js.
  ydoc.on("update", (update, origin) => {
    if (origin === REMOTE || state.closed || !state.admitted) return;
    try {
      ws.send(frameBytes(T.UPDATE, update));
    } catch {
      /* the close handler reports it */
    }
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      stop(message);
      reject(new Error(message));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve(session);
    };

    timers.connect = setTimeout(
      () => fail(`Couldn't reach the collaboration session "${code}" in time.`),
      CONNECT_TIMEOUT_MS,
    );
    timers.admit = setTimeout(
      () =>
        fail(
          `Nobody admitted the request to join session "${code}" within two minutes. The host has to add a ` +
            "participant before they can see the lesson — ask them to look at the collaboration dialog, then try again.",
        ),
      ADMIT_TIMEOUT_MS,
    );

    ws.addEventListener("open", () => {
      clearTimeout(timers.connect);
      timers.connect = null;
      // The room auto-answers this without waking, and it is a text frame so it
      // never reaches the binary handler below.
      timers.ping = setInterval(() => {
        try {
          ws.send("ping");
        } catch {
          /* the close handler cleans up */
        }
      }, PING_MS);
    });

    ws.addEventListener("message", (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return; // the "pong"
      const view = new Uint8Array(ev.data);

      switch (frameType(view)) {
        case T.HELLO: {
          state.slot = readSlot(view);
          // Hosting is the teacher's job. Arriving as host means the code named
          // no live session and the room made us one, which would leave the
          // assistant sitting alone in an empty room it invented.
          if (view[3] === 1) {
            fail(
              `No live session is running under the code "${code}", so joining it would have started a new, empty ` +
                "one. Ask the host to start collaborating in the web editor and give you the code it shows.",
            );
          }
          break;
        }
        case T.ADMITTED: {
          // We're in, and the payload is the room's whole document as one Yjs
          // update. Adopt it before anything is allowed to send.
          applyRemote(ydoc, framePayload(view));
          state.admitted = true;
          clearTimeout(timers.admit);
          timers.admit = null;
          succeed();
          break;
        }
        case T.UPDATE: {
          applyRemote(ydoc, framePayload(view));
          break;
        }
        case T.PRESENCE: {
          const roster = readJson(view);
          if (roster) {
            state.roster = Array.isArray(roster.participants)
              ? roster.participants
              : [];
          }
          break;
        }
        case T.CURSOR: {
          const slot = readSlot(view);
          const cursor = readJson(view, { withSlot: true });
          if (cursor) state.cursors.set(slot, cursor);
          break;
        }
        case T.CHAT: {
          const slot = readSlot(view);
          const msg = readJson(view, { withSlot: true });
          if (!msg) break;
          const who = state.roster.find((p) => p.slot === slot);
          state.chat.push({
            from: who?.name || `participant ${slot}`,
            text: String(msg.text || ""),
            at: new Date(msg.ts || Date.now()).toISOString(),
          });
          break;
        }
        case T.REMOVED: {
          const reason = readText(view) || "removed";
          stop(reason);
          fail(
            reason === "removed"
              ? `The host declined the request to join session "${code}".`
              : `The session ended: ${reason}`,
          );
          break;
        }
        case T.ERROR: {
          fail(readText(view) || "The session refused the connection.");
          break;
        }
        default:
          break;
      }
    });

    ws.addEventListener("close", () => {
      const wasAdmitted = state.admitted;
      clearTimers();
      stop(state.closedReason || "the connection closed");
      // Closing before admission is how the Worker rejects an unauthenticated,
      // rate-limited or unknown-code upgrade: there is no frame for it.
      if (!wasAdmitted) {
        fail(
          `Couldn't join the collaboration session "${code}". Check the code is right, that the host still has ` +
            "the session open, and that this server is signed in (whoami).",
        );
      }
    });

    ws.addEventListener("error", () => {
      fail(`The connection to session "${code}" failed.`);
    });
  });
}

/** Why a closed session can no longer be used, in terms the model can act on. */
export function leftMessage(state) {
  const reason = state?.closedReason || "the connection closed";
  return `Not in a collaboration session any more (${reason}). Call join_collab_session again if the host is still hosting one.`;
}
