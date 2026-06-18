// Real-time lesson collaboration over a Cloudflare Durable Object (one WebSocket
// per participant). This replaces the previous PeerJS/WebRTC peer-to-peer relay:
// instead of the host relaying between browsers, every participant connects a
// single WebSocket to a server-side "room" (the CollabRoom Durable Object; see
// apps/api/src/collab-room.js). The Worker verifies the signed-in user's Supabase
// JWT before the connection reaches the room, so only logged-in users can join
// and their identity is established server-side rather than self-asserted.
//
// Admission model — unchanged from the user's point of view. A guest who connects
// is NOT a collaborator yet: they wait until the host adds them (see `admit`).
// Only after being added does the room hand them the lesson and start syncing.
// Trusted collaborators (an email list saved on the doc) bypass the waiting room:
// the host auto-admits them the instant their request arrives.
//
// Sync model. The room is the authority and relay; it caches the whole document
// (last-write-wins) and re-broadcasts a change to the other admitted peers. The
// document is the unit of sync — it's small (images are content-hash refs, not
// inlined) so sending it whole on each edit is simple and good enough; no CRDT
// needed. Echoes are suppressed by remembering the JSON of the last doc we sent
// or applied and not re-sending an identical one.
//
// Wire protocol — binary frames for speed (see collab-room.js for the full spec).
// Every frame is an ArrayBuffer whose first byte is the message type; the rest is
// the payload. Document/cursor/chat payloads are UTF-8 JSON. A peer is identified
// by a server-assigned numeric "slot"; we map slot -> identity from the presence
// roster so cursors and chat can be labelled without shipping a name in every
// packet.

import { useCallback, useEffect, useRef, useState } from "react";
import { newId } from "./id.js";
import { colorForId } from "./presence.js";

// Message type bytes — must match T in apps/api/src/collab-room.js.
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

// Cap on a single chat message so a peer can't flood the channel with a huge
// string. Chat is ephemeral (kept only in memory for the session).
const MAX_CHAT_LEN = 2000;

const API_URL = import.meta.env.VITE_API_URL;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The wss:// base for the collaboration endpoint, derived from the API URL.
function wsBase() {
  if (!API_URL) return null;
  const base = API_URL.replace(/\/$/, "");
  if (base.startsWith("https://")) return `wss://${base.slice(8)}`;
  if (base.startsWith("http://")) return `ws://${base.slice(7)}`;
  return base;
}

// ----- binary frame builders ------------------------------------------------
function frame(type, payload) {
  const b = new Uint8Array(1 + (payload ? payload.length : 0));
  b[0] = type;
  if (payload) b.set(payload, 1);
  return b;
}

function jsonFrame(type, obj) {
  return frame(type, encoder.encode(JSON.stringify(obj)));
}

// A type byte followed by a u16 slot (used for the host's admit/remove actions).
function slotFrame(type, slot) {
  const b = new Uint8Array(3);
  b[0] = type;
  b[1] = (slot >> 8) & 0xff;
  b[2] = slot & 0xff;
  return b;
}

// A short label for someone we don't have a name for yet.
function shortId(slot) {
  return `guest ${slot}`;
}

/**
 * Collaboration controller hook.
 *
 * @param {object}   opts
 * @param {object}   opts.doc          The current editor document (watched for changes to broadcast).
 * @param {Function} opts.onRemoteDoc  Called with a document received from the room; should replace local state.
 * @param {object}   [opts.identity]   { name, email, avatarUrl } describing the local user (used for our own chat bubbles).
 * @param {string}   [opts.accessToken] The signed-in user's Supabase JWT; required to host or join.
 * @returns Collaboration state and actions (see the returned object).
 */
export function useCollaboration({ doc, onRemoteDoc, identity, accessToken }) {
  // Connection role/status for the UI.
  const [status, setStatus] = useState("idle"); // 'idle' | 'connecting' | 'hosting' | 'joined' | 'error'
  const [role, setRole] = useState(null); // 'host' | 'guest' | null
  const [myCode, setMyCode] = useState(null); // the room's share code
  const [participants, setParticipants] = useState([]); // [{ id, name, email, avatarUrl, host }] admitted
  const [requests, setRequests] = useState([]); // host-only: [{ id, name, email, avatarUrl }] awaiting admission
  const [error, setError] = useState(null);
  // Live editing positions of the *other* collaborators, keyed by their slot
  // (as a string): { [slot]: { uid, name, email, avatarUrl, color, field, start, end, ts } }.
  const [selections, setSelections] = useState({});
  // Chat transcript for this session, oldest first. Ephemeral.
  const [messages, setMessages] = useState([]);

  // Live objects kept in refs (not state) so re-renders don't churn the socket.
  const wsRef = useRef(null);
  const mySlotRef = useRef(null); // our server-assigned slot for this session
  // slot -> { name, email, avatarUrl, host } so we can label cursors/chat from
  // the presence roster rather than trusting per-message identity.
  const rosterRef = useRef(new Map());
  // JSON of the last doc we sent or applied, to break broadcast echo loops.
  const lastSyncedRef = useRef(null);
  // True while we're intentionally tearing down, so the close handler doesn't
  // surface a spurious "disconnected" error.
  const closingRef = useRef(false);
  // Latest doc/identity/callback/role mirrored for use inside the long-lived
  // message handler.
  const docRef = useRef(doc);
  const identityRef = useRef(identity);
  const onRemoteDocRef = useRef(onRemoteDoc);
  const roleRef = useRef(null);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);
  useEffect(() => {
    onRemoteDocRef.current = onRemoteDoc;
  }, [onRemoteDoc]);

  const sendFrame = (b) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(b);
      } catch {
        /* a socket mid-close; the close handler cleans up */
      }
    }
  };

  // Apply a doc received from the room without re-broadcasting it (the parent's
  // resulting state change will match lastSynced and be skipped by the effect).
  const applyRemote = useCallback((nextDoc) => {
    lastSyncedRef.current = JSON.stringify(nextDoc);
    onRemoteDocRef.current?.(nextDoc);
  }, []);

  // Record (or, when a peer leaves their field, clear) a collaborator's editing
  // position. A cursor with no `field` means "I'm no longer editing".
  const applyCursor = useCallback((cursor) => {
    if (!cursor || cursor.uid == null) return;
    setSelections((prev) => {
      const next = { ...prev };
      if (!cursor.field) delete next[cursor.uid];
      else next[cursor.uid] = cursor;
      return next;
    });
  }, []);

  // Append a received chat message, ignoring duplicates (deduped by id).
  const addMessage = useCallback((m) => {
    if (!m || typeof m.text !== "string") return;
    setMessages((prev) => {
      if (m.id && prev.some((x) => x.id === m.id)) return prev;
      return [...prev, m];
    });
  }, []);

  // Whether an email is on this lesson's trusted-collaborator list (read from the
  // live doc). Trusted guests are auto-admitted the moment their request arrives.
  const isTrustedEmail = useCallback((email) => {
    const norm = (email || "").trim().toLowerCase();
    if (!norm) return false;
    const list = docRef.current?.trustedCollaborators;
    return (
      Array.isArray(list) &&
      list.some((t) => (t?.email || "").trim().toLowerCase() === norm)
    );
  }, []);

  // ----- host actions -------------------------------------------------------
  // Add a pending guest to the lesson. The room flips them to admitted, hands
  // them the current doc, and starts syncing them.
  const admit = useCallback((slot) => {
    sendFrame(slotFrame(T.ADMIT, slot));
  }, []);

  // Decline a pending guest or remove an existing collaborator.
  const removeParticipant = useCallback((slot) => {
    sendFrame(slotFrame(T.REMOVE, slot));
  }, []);

  // ----- incoming frames ----------------------------------------------------
  // Handle a single binary frame from the room. Defined once and reused by both
  // host and guest sockets.
  const handleFrame = useCallback(
    (buf) => {
      const view = new Uint8Array(buf);
      if (view.length < 1) return;
      const type = view[0];

      switch (type) {
        case T.HELLO: {
          const slot = (view[1] << 8) | view[2];
          const host = view[3] === 1;
          mySlotRef.current = slot;
          roleRef.current = host ? "host" : "guest";
          setRole(host ? "host" : "guest");
          if (host) {
            setStatus("hosting");
            // Seed the room with our current document so late joiners get it.
            lastSyncedRef.current = JSON.stringify(docRef.current);
            sendFrame(jsonFrame(T.DOC, docRef.current));
          } else {
            setStatus("joined");
          }
          break;
        }
        case T.ADMITTED: {
          // We were added to the lesson; the payload is the current document.
          if (view.length > 1) {
            try {
              applyRemote(JSON.parse(decoder.decode(view.subarray(1))));
            } catch {
              /* ignore a malformed doc */
            }
          }
          break;
        }
        case T.DOC: {
          try {
            applyRemote(JSON.parse(decoder.decode(view.subarray(1))));
          } catch {
            /* ignore */
          }
          break;
        }
        case T.CURSOR: {
          const slot = (view[1] << 8) | view[2];
          let sel;
          try {
            sel = JSON.parse(decoder.decode(view.subarray(3)));
          } catch {
            break;
          }
          const info = rosterRef.current.get(slot) || {};
          applyCursor({
            uid: String(slot),
            name: info.name || shortId(slot),
            email: info.email || "",
            avatarUrl: info.avatarUrl || "",
            color: colorForId(slot),
            field: sel && sel.field ? sel.field : null,
            start: sel ? sel.start : null,
            end: sel ? sel.end : null,
            ts: Date.now(),
          });
          break;
        }
        case T.CHAT: {
          const slot = (view[1] << 8) | view[2];
          let msg;
          try {
            msg = JSON.parse(decoder.decode(view.subarray(3)));
          } catch {
            break;
          }
          const info = rosterRef.current.get(slot) || {};
          addMessage({
            id: msg.id || newId(),
            uid: String(slot),
            name: info.name || shortId(slot),
            email: info.email || "",
            avatarUrl: info.avatarUrl || "",
            text: String(msg.text || "").slice(0, MAX_CHAT_LEN),
            ts: msg.ts || Date.now(),
          });
          break;
        }
        case T.PRESENCE: {
          let roster;
          try {
            roster = JSON.parse(decoder.decode(view.subarray(1)));
          } catch {
            break;
          }
          const list = Array.isArray(roster.participants)
            ? roster.participants
            : [];
          const reqs = Array.isArray(roster.requests) ? roster.requests : [];

          // Refresh the slot -> identity map used to label cursors and chat.
          const map = new Map();
          for (const p of [...list, ...reqs]) {
            map.set(p.slot, {
              name: p.name,
              email: p.email,
              avatarUrl: p.avatarUrl,
              host: p.host,
            });
          }
          rosterRef.current = map;

          setParticipants(
            list.map((p) => ({
              id: p.slot,
              name: p.name,
              email: p.email,
              avatarUrl: p.avatarUrl,
              host: p.host,
            })),
          );
          setRequests(
            reqs.map((p) => ({
              id: p.slot,
              name: p.name,
              email: p.email,
              avatarUrl: p.avatarUrl,
            })),
          );

          // Auto-admit trusted collaborators (host only). admit is idempotent —
          // once admitted they move out of `requests`, so this won't loop.
          if (roleRef.current === "host") {
            for (const r of reqs) {
              if (isTrustedEmail(r.email)) admit(r.slot);
            }
          }

          // Drop cursors for anyone no longer present.
          const present = new Set(list.map((p) => String(p.slot)));
          setSelections((prev) => {
            const next = {};
            for (const k of Object.keys(prev))
              if (present.has(k)) next[k] = prev[k];
            return next;
          });
          break;
        }
        case T.REMOVED: {
          const reason =
            view.length > 1 ? decoder.decode(view.subarray(1)) : "";
          setError(
            reason === "removed" || !reason
              ? "The host removed you from the lesson."
              : reason,
          );
          cleanup();
          setStatus("idle");
          setRole(null);
          break;
        }
        case T.ERROR: {
          setError(
            view.length > 1
              ? decoder.decode(view.subarray(1))
              : "Connection error.",
          );
          cleanup();
          setStatus("error");
          break;
        }
        default:
          break;
      }
    },
    [applyRemote, applyCursor, addMessage, admit, isTrustedEmail],
  );

  // Open a WebSocket to the room and wire its lifecycle. Shared by host and guest.
  const connect = useCallback(
    (code, create) => {
      const base = wsBase();
      if (!base) {
        setError("Collaboration is not configured.");
        setStatus("error");
        return;
      }
      if (!accessToken) {
        setError("Sign in to collaborate.");
        return;
      }
      if (wsRef.current) return;

      setError(null);
      setStatus("connecting");
      setRole(create ? "host" : "guest");
      roleRef.current = create ? "host" : "guest";
      closingRef.current = false;
      mySlotRef.current = null;
      lastSyncedRef.current = null;
      rosterRef.current = new Map();

      const params = new URLSearchParams({ token: accessToken });
      if (create) params.set("create", "1");
      let ws;
      try {
        ws = new WebSocket(
          `${base}/collab/${encodeURIComponent(code)}?${params.toString()}`,
        );
      } catch {
        setError("Could not start collaboration.");
        setStatus("error");
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) handleFrame(ev.data);
      };
      ws.onclose = () => {
        if (closingRef.current) return;
        wsRef.current = null;
        // The Worker rejects an unauthenticated or rate-limited upgrade before
        // the socket opens, which surfaces here as a close without a HELLO.
        if (mySlotRef.current == null) {
          setError(
            create
              ? "Couldn't start the session. Please sign in and try again."
              : "Couldn't connect. The code may be wrong, the host may have left, or you've hit the rate limit.",
          );
        } else if (!error) {
          setError("Disconnected from the collaboration session.");
        }
        cleanup();
        setStatus("idle");
        setRole(null);
      };
      ws.onerror = () => {
        // onclose runs next and owns the user-facing message.
      };
    },
    // `error` is intentionally omitted: it's only read to avoid clobbering an
    // existing message, and including it would re-create the socket callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accessToken, handleFrame],
  );

  // ----- public host/guest entry points -------------------------------------
  const startHosting = useCallback(() => {
    if (wsRef.current) return;
    const code = newId();
    setMyCode(code);
    connect(code, true);
  }, [connect]);

  const joinSession = useCallback(
    (code) => {
      const room = (code || "").trim();
      if (!room) {
        setError("Enter a session code to join.");
        return;
      }
      setMyCode(room);
      connect(room, false);
    },
    [connect],
  );

  // ----- teardown -----------------------------------------------------------
  function cleanup() {
    closingRef.current = true;
    try {
      wsRef.current?.close();
    } catch {
      /* ignore */
    }
    wsRef.current = null;
    mySlotRef.current = null;
    lastSyncedRef.current = null;
    rosterRef.current = new Map();
    setSelections({});
    setMessages([]);
  }

  const leave = useCallback(() => {
    cleanup();
    setStatus("idle");
    setRole(null);
    setMyCode(null);
    setParticipants([]);
    setRequests([]);
    setError(null);
  }, []);

  // Broadcast where we're editing (or that we've stopped, when `sel` is null).
  // We send only { field, start, end }; the room stamps our slot and peers label
  // the cursor from the presence roster. We never add it to our own `selections`.
  const setLocalSelection = useCallback((sel) => {
    if (mySlotRef.current == null) return;
    sendFrame(
      jsonFrame(T.CURSOR, {
        field: sel && sel.field ? sel.field : null,
        start: sel ? sel.start : null,
        end: sel ? sel.end : null,
      }),
    );
  }, []);

  // Send a chat message to everyone in the session. We show our own message
  // immediately (optimistically); the room relays it to the other peers.
  const sendChat = useCallback(
    (text) => {
      const body = String(text || "")
        .trim()
        .slice(0, MAX_CHAT_LEN);
      if (!body || mySlotRef.current == null) return;
      const me = identityRef.current || {};
      const id = newId();
      const ts = Date.now();
      addMessage({
        id,
        uid: String(mySlotRef.current),
        name: me.name || "",
        email: me.email || "",
        avatarUrl: me.avatarUrl || "",
        text: body,
        ts,
      });
      sendFrame(jsonFrame(T.CHAT, { id, text: body, ts }));
    },
    [addMessage],
  );

  // Tear down the socket when the component using this hook unmounts.
  useEffect(() => () => cleanup(), []);

  // Broadcast local edits. Runs whenever `doc` changes; sends only when the doc
  // actually differs from the last one we synced (which both prevents echoing a
  // just-received doc and de-dupes no-op renders).
  useEffect(() => {
    if (status !== "hosting" && status !== "joined") return;
    const json = JSON.stringify(doc);
    if (json === lastSyncedRef.current) return;
    lastSyncedRef.current = json;
    sendFrame(jsonFrame(T.DOC, doc));
  }, [doc, status]);

  const active =
    status === "hosting" || status === "joined" || status === "connecting";

  return {
    status,
    role,
    myCode,
    participants,
    requests,
    error,
    active,
    selections,
    messages,
    myId: mySlotRef.current == null ? null : String(mySlotRef.current),
    startHosting,
    joinSession,
    admit,
    removeParticipant,
    leave,
    setLocalSelection,
    sendChat,
    clearError: () => setError(null),
  };
}
