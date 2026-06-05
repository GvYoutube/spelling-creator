---
title: Live collaboration
sidebar_position: 8
---

# Live collaboration

Press **Collaborate** in the editor toolbar to edit a lesson together with other
people in real time. The connection is **peer-to-peer over WebRTC** ([PeerJS](https://peerjs.com/));
there is no collaboration backend, so it works on any static host. PeerJS's public
broker is used only for the initial signalling handshake — the lesson data then
flows directly between browsers.

**Host vs. guest.** Whoever opens the session is the _host_ and the authority for
the document; everyone else is a _guest_.

1. The host clicks **Start a collaboration session** and gets a short **session
   code** (their PeerJS peer id) plus a one-click **invite link**
   (`/?join=<code>`, which deep-links a recipient straight to the join screen).
2. A guest pastes the code (or opens the invite link) and connects. Connecting
   does **not** yet make them a collaborator.
3. The guest appears in the host's **Waiting to join** list. The host clicks
   **Add to lesson** — this is the gate the feature is built around: only after a
   guest is _added_ does the host send them the lesson and start syncing edits.
   The host can decline a request or remove a collaborator at any time.
4. Once added, edits sync **both ways**: the whole document is the unit of sync
   (last-write-wins), the host re-broadcasts each guest's change to the other
   guests, and a presence roster shows everyone in the lesson.

**Live cursors.** Each collaborator's text selection is broadcast to the others,
so you can see where everyone is working. `useSelectionBroadcast`
(`src/lib/useSelectionBroadcast.js`) sends the local selection, the hook exposes
everyone else's via `collab.selections`, and `CollabCursors.jsx` renders the
floating coloured carets/highlights over the editor.

**Live chat.** Once you're collaborating, a floating chat panel (`CollabChat.jsx`,
pinned to the bottom-left) lets everyone in the session talk. It appears for the
host as soon as a session is live and for a guest once the host has added them.
The transcript is **ephemeral** — it lives only in memory for the duration of the
session and is not saved anywhere; the host relays each message out to the other
guests, and a launcher badge shows the unread count while the panel is collapsed.

**Connection settings (TURN).** Most peer connections succeed over **STUN** alone,
which needs no credentials. For networks that block direct peer-to-peer
connections, the **Connection settings (optional)** section of the Collaborate
dialog lets you add a **TURN relay** — a URL, username, and password. These are
bring-your-own (the dialog recommends [ExpressTURN](https://www.expressturn.com/)
or [Metered OpenRelay](https://www.metered.ca/tools/openrelay/)), saved in
`localStorage` on that device only, and folded into the WebRTC ICE list only when
both a username and password are supplied. `src/lib/iceServers.js` owns the STUN
list, the credential storage, and `getIceServers()`.

Peers are identified by a **UUID carried in the PeerJS connection `metadata`**
(alongside the guest's name/email), not by the PeerJS peer id — the peer id is, per
the PeerJS docs, "meant to be used for brokering connections only." The host reads
that metadata the moment a connection arrives, so no separate hello handshake is
needed.

**Implementation.** `src/lib/collab.js` is a `useCollaboration` hook that owns the
PeerJS peer, the connection map (keyed by guest UUID), the admission state, the
chat transcript, and the broadcast/echo-suppression logic. `src/components/CollaborateDialog.jsx`
is the control panel (host/join landing, invite sharing, the waiting-to-join
admission list, the roster, and the optional TURN connection settings). `EditorPage` wires the hook's `onRemoteDoc` to its `setDoc` and watches
`doc` so local edits broadcast automatically. The lesson document is small, so it
is shipped whole on each change rather than as a CRDT diff.
