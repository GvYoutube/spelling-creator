---
title: Live sessions
---

# Live sessions

An assistant can join a [live collaboration session](/web-app/live-collaboration) as a
participant, the same way a second teacher would: it gets a slot in the room, its edits
appear on everyone's screen as it makes them, and the host can remove it at any moment.

## Why not just edit the lesson

Because while a session is running, **the lesson on the hub is not the lesson**. A
session's document lives in the room until somebody saves it, so the stored copy is
whatever it was before the session started. An assistant using `patch_lesson` during a
session is editing a stale copy, and the host's next save overwrites whatever it did.

The other half is that a room is two-way. An API write is a statement; a session is a
conversation — the assistant edits under a participant of its own, the teacher watches
each change land, and the session chat is a channel for asking rather than guessing.

## The tools

| Tool                   | What it does                                                               |
| ---------------------- | -------------------------------------------------------------------------- |
| `join_collab_session`  | Join by share code, and wait for the host to admit you.                    |
| `read_collab_doc`      | The lesson as the session holds it now, plus any chat since you last read. |
| `edit_collab_doc`      | Apply `patch_lesson`-shaped operations to the shared document.             |
| `send_collab_chat`     | Say something to the room.                                                 |
| `leave_collab_session` | Disconnect, leaving the lesson as it is.                                   |

A typical flow:

```text
(the user clicks Collaborate in the editor and reads out the code)
join_collab_session({ code: "…" })    -> waits for them to admit you
read_collab_doc()                     -> the live lesson, with ids
send_collab_chat({ text: "Adding section 3 now." })
edit_collab_doc({ operations: [ … ] })
leave_collab_session()
```

## Who the host sees

An assistant joins on the user's own account — it holds their token, because that is the
only identity it has. Left alone that puts two cursors in the room with the same name, and
the host has no way to tell which one is a person.

So the connection declares itself. `join_collab_session` adds `?assistant=<client name>`,
taking the name from the connecting MCP client's own account of itself, and the Worker
renders the participant as:

```text
Ms Kelly · Claude Desktop        [AI]
```

The decorated name flows into the floating cursors and chat labels automatically, since
both already read from the presence roster; the roster entry also carries `bot: true`, which
is what the **AI** badge in the Collaborate dialog reads.

**This is self-declared, and deliberately not a security control.** The account is
authenticated; the label is not. A connection that lies can only make itself _look_ like an
assistant, or decline to admit that it is one — neither of which grants it anything, and
the room still gates what matters on the host admitting a participant they can see. What
it buys is that the honest case, which is every case shipped here, is legible.

The label is bounded to 40 characters and stripped of control characters, line breaks and
the `·` separator, so it cannot crowd out or impersonate the display name that _was_
verified.

## What the design leans on

Three properties of the room, none of them new — the session tools are built on the
collaboration model the web app already had:

- **Admission is the host's.** A joining participant waits until the host adds them, so
  nothing here can put an assistant into a session uninvited. That gate already existed for
  people; the assistant is subject to it unchanged. `join_collab_session` waits up to two
  minutes and then gives up.
- **Edits merge.** The room is a CRDT, so an assistant writing section 3 while the teacher
  writes section 5 costs neither of them their work.
- **Removal is instant.** The host can eject a participant mid-edit, which is a better stop
  button than any tool call could offer.

## What does not merge

Text within **one field** is still last-write-wins — `reconcile` stores it as a plain
string (see `packages/core/src/ydoc.js`), so two people typing in the same paragraph means
one of them loses a sentence.

`edit_collab_doc` therefore refuses any operation addressing a block another participant's
cursor is currently in, and names who is there:

```text
Someone else's cursor is in a block this edit would rewrite: b7 (Ms Kelly). Text in a
single field doesn't merge — one of you would lose the sentence. Edit somewhere else, or
ask in the chat for them to move off it and try again.
```

Cursors are advisory and go stale, so this is checked at the moment of the edit rather than
cached. It is a guard against the common case, not a lock.

## Validation is reported, not enforced

`edit_collab_doc` runs the [authoring standard](/mcp-server/lesson-validation) over the
result and reports what the edit breaks, but it does **not** reject. This is the user's
live document with the user watching: refusing a change they just asked for, because a
different section is off-standard, would be worse than telling them about it. The writing
tools that save to the hub still reject, as they always did.

## Nothing is saved

`edit_collab_doc` changes the session's document and nothing else. The lesson is the host's
to keep — they save it from the editor — so an assistant should **not** follow up with
`update_lesson` or `patch_lesson` to "finish the job": that writes to the stale stored copy
and the host's next save discards it.

## Availability

- **stdio only.** The tools are registered only on a transport that can hold a socket open
  between tool calls. The [remote transport](/mcp-server/remote-mode) builds a fresh server
  per request and has nowhere to keep a session, so they are absent there rather than
  advertised and broken.
- **Node 22 or newer.** The session needs a WebSocket, which Node gained globally in v21
  and stabilised in v22. Rather than take a dependency on `ws` for one optional feature,
  `join_collab_session` says what it needs and everything else in the server works as
  normal.
- **One session at a time.** An assistant in two sessions has no way to say which one an
  edit is meant for.

## The wire protocol

All three ends — the room (`apps/api/src/collab-room.js`), the browser
(`apps/web/src/lib/collab.js`) and this server (`apps/mcp/src/collab.js`) — speak the frame
format defined once in `packages/core/src/collabFrames.js`. It used to live as two copies
joined by a comment reading "must match T in collab-room.js", which is a convention rather
than a guarantee; a renumbered frame is not a crash but a silent misread, on a byte array
nobody can eyeball.
