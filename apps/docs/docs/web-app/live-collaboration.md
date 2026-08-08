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

   That trusted list carries one further privilege, outside the live session: a
   trusted collaborator may **merge a fork back into the lesson** — the only way a
   non-author can write to one. See
   [Version history](/monorepo/version-history#merging-a-fork-back-in-trusted-collaborators)
   for what that does and does not let them do.

4. Once added, edits sync **both ways**: the room merges each change into the
   session's document, re-broadcasts it to the other admitted collaborators, and a
   presence roster shows everyone in the lesson.

**Conflict handling (CRDT).** Edits are merged with a **CRDT** ([Yjs](https://yjs.dev)),
not applied last-write-wins. Two people working on **different blocks, sections or
fields** both keep their work — previously the document was synced whole, so
whoever typed last silently overwrote the other. Every participant keeps a Yjs
document mirroring the lesson, the room holds the authoritative copy, and only the
**changes** travel over the wire rather than the whole lesson on every keystroke.

The one deliberate limit: text is merged **per field**, not per character. If two
people type into the **same** field at the same time, one of them still wins (both
sides agree on which). Editing different blocks — the normal case — always merges.

**Binary wire protocol.** Messages are sent as **binary WebSocket frames** for
speed: a one-byte type tag followed by the payload. Cursor and chat payloads are
UTF-8 JSON; document payloads are opaque Yjs update bytes, which the room relays
without parsing. A participant is identified by a server-assigned numeric **slot**
rather than by name in every packet; the client maps slot → identity from the
presence roster to label cursors and chat.

**Live cursors.** Each collaborator's text selection is relayed to the others, so
you can see where everyone is working. `useSelectionBroadcast`
(`src/lib/useSelectionBroadcast.js`) reports the local selection, the hook exposes
everyone else's via `collab.selections`, and `CollabCursors.jsx` renders the
floating coloured carets/avatars over the editor.

A caret is drawn only for a field that's actually on screen. Sections you have
[collapsed](./navigating-large-lessons.md#collapsing-sections) are hidden with
`content-visibility`, whose descendants still measure as full-size, so
`CollabCursors` tests `Element.checkVisibility()` rather than geometry —
otherwise a collaborator editing inside a folded section would have their avatar
pinned over the collapsed card. Their edits still arrive as normal; only the
marker is suppressed. Collapsed state is per-person and never leaves the
browser, so nobody else's view is affected by what you fold away.

**Live chat.** Once you're collaborating, a floating chat panel (`CollabChat.jsx`,
pinned to the bottom-left) lets everyone in the session talk. It appears for the
host as soon as a session is live and for a guest once the host has added them.
The transcript is **ephemeral** — it lives only in memory for the duration of the
session and is not saved anywhere; a launcher badge shows the unread count while
the panel is collapsed.

**Rate limits.** Because the relay is server-side, it is rate-limited to keep it
cheap and abuse-resistant: at most **5 session joins per minute** and **6
concurrent hosted rooms** per user, **10 participants** per room, and per
connection a budget of **30 document updates, 15 cursor moves and 2 chat messages
per second** (a single update is capped at 512 KB — a ceiling that only the host's
opening copy of the lesson ever approaches, since ordinary edits are a few bytes).
Over-budget traffic is dropped, and a connection that keeps flooding is closed.

**Implementation.** `@spelling-creator/core/ydoc` owns the CRDT: it maps the editor's plain
lesson document (`{ title, sections: [...] }`) onto a Yjs document and back. The
editor itself is untouched by any of this — it keeps working on plain objects, and
`ydoc` keeps a Yjs document in step underneath, matching sections, blocks,
spelling words and answers by the stable `id` they already carry. Its `reconcile`
is **idempotent**, which is what stops a received edit from bouncing straight back
to the sender.

`src/lib/collab.js` is a `useCollaboration` hook that owns the WebSocket, the
Yjs document, the slot → identity roster, the admission state and the chat
transcript. `src/components/CollaborateDialog.jsx` is the control panel (host/join
landing, invite sharing, the waiting-to-join admission list, and the roster).
`EditorPage` wires the hook's `onRemoteDoc` to its `setDoc`, passes the access
token, and watches `doc` so local edits broadcast automatically.

The server side lives in `apps/api/src/collab-room.js` (the `CollabRoom` Durable
Object, which holds the session's authoritative Yjs document, persists it to
SQLite so it survives hibernation, and relays updates) and `handleCollab` in
`apps/api/src/index.js` (the JWT gate, connection rate limits, and forwarding to
the room).

Yjs is used **only for the live session**. Lessons are still stored as plain JSON,
so nothing about saving, exporting, forking or version history changes.
