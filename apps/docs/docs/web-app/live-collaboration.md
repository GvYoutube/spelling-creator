---
title: Live collaboration
sidebar_position: 8
---

# Live collaboration

Press **Collaborate** in the editor toolbar to edit a lesson together with other
people in real time. Each participant opens **a single WebSocket** to a
server-side **room** — a [Cloudflare Durable Object](https://developers.cloudflare.com/durable-objects/)
(`CollabRoom`) that is the authority and relay for the session. The companion
Worker verifies your **Supabase sign-in** before the connection reaches the room,
so **only logged-in users can host or join**, and your identity is established
server-side (it can't be spoofed by the client).

**Host vs. guest.** Whoever opens the session is the _host_; everyone else is a
_guest_. The room caches the current document so it can hand the latest copy to a
guest the moment they're added.

1. The host clicks **Start a collaboration session** and gets a short **session
   code** plus a one-click **invite link** (`/?join=<code>`, which deep-links a
   recipient straight to the join screen).
2. A guest pastes the code (or opens the invite link) and connects. Connecting
   does **not** yet make them a collaborator.
3. The guest appears in the host's **Waiting to join** list. The host clicks
   **Add to lesson** — this is the gate the feature is built around: only after a
   guest is _added_ does the room send them the lesson and start syncing edits.
   The host can decline a request or remove a collaborator at any time. **Trusted
   collaborators** (an email list saved on the lesson) skip the waiting room and
   are admitted automatically.
4. Once added, edits sync **both ways**: the whole document is the unit of sync
   (last-write-wins), the room re-broadcasts each change to the other admitted
   collaborators, and a presence roster shows everyone in the lesson.

**Binary wire protocol.** Messages are sent as **binary WebSocket frames** for
speed: a one-byte type tag followed by the payload (document, cursor and chat
payloads are UTF-8 JSON, so the room can relay document bytes without parsing
them). A participant is identified by a server-assigned numeric **slot** rather
than by name in every packet; the client maps slot → identity from the presence
roster to label cursors and chat.

**Live cursors.** Each collaborator's text selection is relayed to the others, so
you can see where everyone is working. `useSelectionBroadcast`
(`src/lib/useSelectionBroadcast.js`) reports the local selection, the hook exposes
everyone else's via `collab.selections`, and `CollabCursors.jsx` renders the
floating coloured carets/avatars over the editor.

**Live chat.** Once you're collaborating, a floating chat panel (`CollabChat.jsx`,
pinned to the bottom-left) lets everyone in the session talk. It appears for the
host as soon as a session is live and for a guest once the host has added them.
The transcript is **ephemeral** — it lives only in memory for the duration of the
session and is not saved anywhere; a launcher badge shows the unread count while
the panel is collapsed.

**Rate limits.** Because the relay is server-side, it is rate-limited to keep it
cheap and abuse-resistant: at most **5 session joins per minute** and **6
concurrent hosted rooms** per user, **10 participants** per room, and per
connection a budget of **8 document edits, 15 cursor moves and 2 chat messages
per second** (document updates are capped at 512 KB). Over-budget traffic is
dropped, and a connection that keeps flooding is closed.

**Implementation.** `src/lib/collab.js` is a `useCollaboration` hook that owns the
WebSocket, the slot → identity roster, the admission state, the chat transcript,
and the broadcast/echo-suppression logic. `src/components/CollaborateDialog.jsx`
is the control panel (host/join landing, invite sharing, the waiting-to-join
admission list, and the roster). `EditorPage` wires the hook's `onRemoteDoc` to
its `setDoc`, passes the access token, and watches `doc` so local edits broadcast
automatically. The server side lives in `apps/api/src/collab-room.js` (the
`CollabRoom` Durable Object) and `handleCollab` in `apps/api/src/index.js` (the
JWT gate, connection rate limits, and forwarding to the room). The lesson
document is small (images are content-hash references, not inlined), so it is
shipped whole on each change rather than as a CRDT diff.
