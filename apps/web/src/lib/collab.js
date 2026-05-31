// Real-time lesson collaboration over PeerJS (WebRTC). This is fully
// peer-to-peer: there is no collaboration backend. The lesson owner ("host")
// opens a session and gets a short share code (their PeerJS peer id). Other
// people ("guests") connect to that code with the public PeerJS broker doing
// only the initial signalling; the lesson data then flows directly between
// browsers.
//
// Admission model — "add a user to the lesson". A guest who connects is NOT a
// collaborator yet: they sit in a pending list until the host explicitly adds
// them (see `admit`). Only after being added does the host send them the lesson
// and start syncing their edits. This mirrors the request: users collaborate
// *after* being added to the lesson. The one exception is trusted
// collaborators (an email list saved on the doc): they bypass the waiting room
// and are admitted automatically the instant they connect.
//
// Sync model. The host is the authority and relay. The whole document is the
// unit of sync (last-write-wins): whenever the local doc changes, the changed
// side sends the full doc; the host re-broadcasts a guest's change to the other
// admitted guests. Echoes are suppressed by remembering the JSON of the last
// doc we sent or received and not re-sending an identical one. The lesson doc
// here is small (text/questions; images are data-urls), so shipping it whole on
// each edit is simple and good enough — no CRDT needed.

import { useCallback, useEffect, useRef, useState } from "react";
import Peer from "peerjs";
import { newId } from "./id.js";
import { colorForId } from "./presence.js";
import { iceServers } from "./iceServers.js";

// We identify peers by a UUID we generate ourselves and pass in the PeerJS
// connection `metadata`, NOT by the PeerJS peer id. Per the PeerJS docs the peer
// id "is meant to be used for brokering connections only"; identifying
// information belongs in `metadata`. A guest therefore announces itself entirely
// through the connect metadata { uid, name, email }, which the host can read the
// moment the connection arrives — no separate hello handshake needed.
//
// Wire message shapes (all `{ t: <type>, ... }`):
//   host  -> guest { t: 'admitted', doc }           added to the lesson; here's the doc
//   host  -> guest { t: 'removed' }                  request declined / removed
//   any   -> any   { t: 'doc', doc }                 full document update
//   host  -> guests{ t: 'presence', participants }   who is collaborating now
//   any   -> any   { t: 'cursor', cursor }            where someone is editing
const MSG = {
  ADMITTED: "admitted",
  REMOVED: "removed",
  DOC: "doc",
  PRESENCE: "presence",
  CURSOR: "cursor",
};

// A short label for someone we don't have a name for yet (derived from their uid).
function shortId(id) {
  return id ? id.slice(0, 6) : "guest";
}

/**
 * Collaboration controller hook.
 *
 * @param {object}   opts
 * @param {object}   opts.doc          The current editor document (watched for changes to broadcast).
 * @param {Function} opts.onRemoteDoc  Called with a document received from a peer; should replace local state.
 * @param {object}   [opts.identity]   { name, email } describing the local user, shared as presence.
 * @returns Collaboration state and actions (see the returned object).
 */
export function useCollaboration({ doc, onRemoteDoc, identity }) {
  // Connection role/status for the UI.
  const [status, setStatus] = useState("idle"); // 'idle' | 'hosting' | 'connecting' | 'joined' | 'error'
  const [role, setRole] = useState(null); // 'host' | 'guest' | null
  const [myCode, setMyCode] = useState(null); // host's peer id (the share code)
  const [participants, setParticipants] = useState([]); // [{ id, name, email }] admitted collaborators
  const [requests, setRequests] = useState([]); // host-only: [{ id, name, email }] awaiting admission
  const [error, setError] = useState(null);
  // Live editing positions of the *other* collaborators, keyed by their id:
  // { [uid]: { uid, name, email, avatarUrl, color, field, start, end, ts } }.
  // Our own cursor is never stored here — we only render the people we receive.
  const [selections, setSelections] = useState({});

  // Live objects kept in refs (not state) so re-renders don't churn connections.
  const peerRef = useRef(null);
  // Host: peerId -> { conn, info: { name, email }, admitted: boolean }
  const connsRef = useRef(new Map());
  // Guest: the single DataConnection back to the host.
  const hostConnRef = useRef(null);
  // Our own stable id for cursor presence: "host" when hosting, our join UUID
  // when a guest. It matches the id the host assigns us in the roster.
  const myCursorIdRef = useRef(null);
  // JSON of the last doc we sent or applied, to break broadcast echo loops.
  const lastSyncedRef = useRef(null);
  // Latest doc/identity/callback mirrored for use inside long-lived listeners.
  const docRef = useRef(doc);
  const identityRef = useRef(identity);
  const onRemoteDocRef = useRef(onRemoteDoc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);
  useEffect(() => {
    onRemoteDocRef.current = onRemoteDoc;
  }, [onRemoteDoc]);

  const send = (conn, msg) => {
    try {
      if (conn && conn.open) conn.send(msg);
    } catch {
      /* a half-open connection — the close handler will clean it up */
    }
  };

  // Host: publish the admitted-collaborator roster to React state and to guests.
  const syncHostParticipants = useCallback(() => {
    const admitted = [];
    const pending = [];
    for (const [id, rec] of connsRef.current) {
      const entry = {
        id,
        name: rec.info.name,
        email: rec.info.email,
        avatarUrl: rec.info.avatarUrl || "",
      };
      (rec.admitted ? admitted : pending).push(entry);
    }
    // The host is a participant too, listed first.
    const me = identityRef.current || {};
    const all = [
      {
        id: "host",
        name: me.name || "You (host)",
        email: me.email || "",
        avatarUrl: me.avatarUrl || "",
        host: true,
      },
      ...admitted,
    ];
    setParticipants(all);
    setRequests(pending);
    const presence = { t: MSG.PRESENCE, participants: all };
    for (const [, rec] of connsRef.current) {
      if (rec.admitted) send(rec.conn, presence);
    }
  }, []);

  // Apply a doc received from a peer without re-broadcasting it (the parent's
  // resulting state change will match lastSynced and be skipped by the effect).
  const applyRemote = useCallback((nextDoc) => {
    lastSyncedRef.current = JSON.stringify(nextDoc);
    onRemoteDocRef.current?.(nextDoc);
  }, []);

  // Record (or, when a peer leaves their field, clear) a collaborator's editing
  // position. A cursor with no `field` means "I'm no longer editing".
  const applyCursor = useCallback((cursor) => {
    if (!cursor || !cursor.uid) return;
    setSelections((prev) => {
      const next = { ...prev };
      if (!cursor.field) delete next[cursor.uid];
      else next[cursor.uid] = cursor;
      return next;
    });
  }, []);

  // Forget a collaborator's cursor entirely (they left or were removed).
  const forgetCursor = useCallback((uid) => {
    setSelections((prev) => {
      if (!(uid in prev)) return prev;
      const next = { ...prev };
      delete next[uid];
      return next;
    });
  }, []);

  // Whether an email is on this lesson's trusted-collaborator list, read from
  // the live doc. Trusted guests skip the waiting room and are admitted the
  // moment they connect (see the connection handler below).
  const isTrustedEmail = useCallback((email) => {
    const norm = (email || "").trim().toLowerCase();
    if (!norm) return false;
    const list = docRef.current?.trustedCollaborators;
    return (
      Array.isArray(list) &&
      list.some((t) => (t?.email || "").trim().toLowerCase() === norm)
    );
  }, []);

  // ----- Host -------------------------------------------------------------
  const startHosting = useCallback(() => {
    if (peerRef.current) return;
    setError(null);
    setStatus("connecting");
    setRole("host");

    const peer = new Peer({
      config: {
        iceServers: iceServers,
      },
    });
    peerRef.current = peer;

    peer.on("open", (id) => {
      setMyCode(id);
      setStatus("hosting");
      myCursorIdRef.current = "host";
      // Seed lastSynced with the current doc so we don't treat the first edit
      // as new vs. a null baseline (no functional harm either way).
      lastSyncedRef.current = JSON.stringify(docRef.current);
      syncHostParticipants();
    });

    peer.on("connection", (conn) => {
      // Identify the guest by the UUID in their connection metadata, falling back
      // to the (brokering-only) peer id if a client somehow sent none. The same
      // metadata carries their display name/email, so we know who they are as
      // soon as they connect.
      const meta = conn.metadata || {};
      const uid = meta.uid || conn.peer;
      const info = {
        name: meta.name || shortId(uid),
        email: meta.email || "",
        avatarUrl: meta.avatarUrl || "",
      };

      conn.on("open", () => {
        // Trusted collaborators (matched by email) are admitted automatically:
        // we hand them the doc immediately rather than parking them as a
        // pending request for the host to approve.
        const trusted = isTrustedEmail(info.email);
        connsRef.current.set(uid, { conn, info, admitted: trusted });
        if (trusted) send(conn, { t: MSG.ADMITTED, doc: docRef.current });
        syncHostParticipants();
      });

      conn.on("data", (msg) => {
        if (!msg || typeof msg !== "object") return;
        const rec = connsRef.current.get(uid);
        if (!rec) return;
        if (msg.t === MSG.DOC && rec.admitted) {
          // A collaborator edited: adopt it, then relay to the other guests.
          applyRemote(msg.doc);
          for (const [pid, other] of connsRef.current) {
            if (pid !== uid && other.admitted) {
              send(other.conn, { t: MSG.DOC, doc: msg.doc });
            }
          }
        } else if (msg.t === MSG.CURSOR && rec.admitted) {
          // A collaborator moved their caret: show it, then relay to the rest.
          // Stamp the sender's id from the connection so a peer can't spoof it.
          const cursor = { ...msg.cursor, uid };
          applyCursor(cursor);
          for (const [pid, other] of connsRef.current) {
            if (pid !== uid && other.admitted) {
              send(other.conn, { t: MSG.CURSOR, cursor });
            }
          }
        }
        // Messages from a not-yet-admitted guest are ignored by design.
      });

      const drop = () => {
        connsRef.current.delete(uid);
        forgetCursor(uid);
        syncHostParticipants();
      };
      conn.on("close", drop);
      conn.on("error", drop);
    });

    peer.on("error", (err) => {
      setError(err?.message || "Connection error.");
      setStatus("error");
    });
  }, [
    applyRemote,
    applyCursor,
    forgetCursor,
    syncHostParticipants,
    isTrustedEmail,
  ]);

  // Host: add a pending guest to the lesson. This is the "add the user" step —
  // it flips them to admitted, hands them the current doc, and starts syncing.
  const admit = useCallback(
    (peerId) => {
      const rec = connsRef.current.get(peerId);
      if (!rec) return;
      rec.admitted = true;
      send(rec.conn, { t: MSG.ADMITTED, doc: docRef.current });
      syncHostParticipants();
    },
    [syncHostParticipants],
  );

  // Host: decline a pending guest or remove an existing collaborator.
  const removeParticipant = useCallback(
    (peerId) => {
      const rec = connsRef.current.get(peerId);
      if (!rec) return;
      send(rec.conn, { t: MSG.REMOVED });
      try {
        rec.conn.close();
      } catch {
        /* ignore */
      }
      connsRef.current.delete(peerId);
      forgetCursor(peerId);
      syncHostParticipants();
    },
    [forgetCursor, syncHostParticipants],
  );

  // ----- Guest ------------------------------------------------------------
  const joinSession = useCallback(
    (code) => {
      const hostId = (code || "").trim();
      if (!hostId) {
        setError("Enter a session code to join.");
        return;
      }
      if (peerRef.current) return;
      setError(null);
      setStatus("connecting");
      setRole("guest");

      // Our own identifier for this session: a UUID we send in the connection
      // metadata so the host identifies us by it rather than by our peer id.
      const myUid = newId();
      myCursorIdRef.current = myUid;

      const peer = new Peer();
      peerRef.current = peer;

      peer.on("open", () => {
        const me = identityRef.current || {};
        const conn = peer.connect(hostId, {
          reliable: true,
          metadata: {
            uid: myUid,
            name: me.name || "",
            email: me.email || "",
            avatarUrl: me.avatarUrl || "",
          },
        });
        hostConnRef.current = conn;

        conn.on("open", () => {
          setStatus("joined");
        });

        conn.on("data", (msg) => {
          if (!msg || typeof msg !== "object") return;
          if (msg.t === MSG.ADMITTED) {
            applyRemote(msg.doc);
          } else if (msg.t === MSG.DOC) {
            applyRemote(msg.doc);
          } else if (msg.t === MSG.CURSOR) {
            applyCursor(msg.cursor);
          } else if (msg.t === MSG.PRESENCE) {
            const list = Array.isArray(msg.participants)
              ? msg.participants
              : [];
            setParticipants(list);
            // Drop cursors for anyone no longer in the lesson. Participant ids
            // are the same uids cursors are keyed by (host assigns both).
            const ids = new Set(list.map((p) => p.id));
            setSelections((prev) => {
              const next = {};
              for (const k of Object.keys(prev))
                if (ids.has(k)) next[k] = prev[k];
              return next;
            });
          } else if (msg.t === MSG.REMOVED) {
            setError("The host removed you from the lesson.");
            cleanup();
            setStatus("idle");
          }
        });

        conn.on("close", () => {
          setError("Disconnected from the host.");
          cleanup();
          setStatus("idle");
        });
        conn.on("error", () => {
          setError("Lost connection to the host.");
        });
      });

      peer.on("error", (err) => {
        // The most common cause is a bad/expired code (host peer not found).
        const msg =
          err?.type === "peer-unavailable"
            ? "No session found for that code. Check it and try again."
            : err?.message || "Could not connect.";
        setError(msg);
        setStatus("error");
      });
    },
    [applyRemote, applyCursor],
  );

  // ----- Teardown ---------------------------------------------------------
  function cleanup() {
    for (const [, rec] of connsRef.current) {
      try {
        rec.conn.close();
      } catch {
        /* ignore */
      }
    }
    connsRef.current.clear();
    try {
      hostConnRef.current?.close();
    } catch {
      /* ignore */
    }
    hostConnRef.current = null;
    try {
      peerRef.current?.destroy();
    } catch {
      /* ignore */
    }
    peerRef.current = null;
    lastSyncedRef.current = null;
    myCursorIdRef.current = null;
    setSelections({});
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
  // The cursor carries our identity so collaborators can label and colour it
  // without a separate lookup. We never add it to our own `selections`.
  const setLocalSelection = useCallback(
    (sel) => {
      const id = myCursorIdRef.current;
      if (!id) return;
      const me = identityRef.current || {};
      const cursor = {
        uid: id,
        name: me.name || "",
        email: me.email || "",
        avatarUrl: me.avatarUrl || "",
        color: colorForId(id),
        field: sel && sel.field ? sel.field : null,
        start: sel ? sel.start : null,
        end: sel ? sel.end : null,
        ts: Date.now(),
      };
      const msg = { t: MSG.CURSOR, cursor };
      if (role === "host") {
        for (const [, rec] of connsRef.current) {
          if (rec.admitted) send(rec.conn, msg);
        }
      } else if (role === "guest") {
        send(hostConnRef.current, msg);
      }
    },
    [role],
  );

  // Tear down the peer when the component using this hook unmounts.
  useEffect(() => () => cleanup(), []);

  // Broadcast local edits. Runs whenever `doc` changes; sends only when the doc
  // actually differs from the last one we synced (which both prevents echoing a
  // just-received doc and de-dupes no-op renders).
  useEffect(() => {
    if (status !== "hosting" && status !== "joined") return;
    const json = JSON.stringify(doc);
    if (json === lastSyncedRef.current) return;
    lastSyncedRef.current = json;
    if (role === "host") {
      for (const [, rec] of connsRef.current) {
        if (rec.admitted) send(rec.conn, { t: MSG.DOC, doc });
      }
    } else if (role === "guest") {
      send(hostConnRef.current, { t: MSG.DOC, doc });
    }
  }, [doc, status, role]);

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
    startHosting,
    joinSession,
    admit,
    removeParticipant,
    leave,
    setLocalSelection,
    clearError: () => setError(null),
  };
}
