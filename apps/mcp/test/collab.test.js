// Joining a live collaboration session headlessly (src/collab.js) and the tools
// over it (src/collabTools.js).
//
// There is no WebSocket *server* in Node without a dependency, and the room
// itself is a Durable Object tested in apps/api. So these swap globalThis.
// WebSocket for a fake the test drives directly: it records the frames the
// session sends and lets the test push frames back as the room would. That is
// the right seam anyway — what's under test here is this end of the protocol.

import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  T,
  frameBytes,
  frameJson,
  frameType,
  frameWithSlot,
} from "@spelling-creator/core/collabFrames";
import { reconcile } from "@spelling-creator/core/ydoc";

import { joinSession } from "../src/collab.js";
import { registerTools, SERVER_INFO } from "../src/tools.js";

/** A lesson, as one Yjs update — what the room hands a joiner on ADMITTED. */
function seedUpdate(doc) {
  const ydoc = new Y.Doc();
  reconcile(ydoc, doc);
  return Y.encodeStateAsUpdate(ydoc);
}

const LESSON = {
  title: "Volcanoes",
  sections: [
    {
      id: "s1",
      name: "Reading",
      blocks: [
        { id: "b1", type: "text", text: "A volcano ERUPTS." },
        { id: "b2", type: "text", text: "MAGMA rises." },
      ],
    },
  ],
};

/**
 * Install a fake WebSocket and hand back a handle for driving it. Returns a
 * `restore` the test must call, since the global is process-wide.
 */
function fakeSocket() {
  const handle = {
    sent: [],
    listeners: new Map(),
    url: null,
    closed: false,
  };

  class FakeWebSocket {
    constructor(url) {
      handle.url = url;
      handle.socket = this;
      // The room's own accept is async; opening on a microtask keeps the
      // ordering realistic without making the tests wait on timers.
      queueMicrotask(() => handle.emit("open", {}));
    }
    set binaryType(_v) {}
    addEventListener(type, fn) {
      const list = handle.listeners.get(type) || [];
      list.push(fn);
      handle.listeners.set(type, list);
    }
    send(data) {
      handle.sent.push(typeof data === "string" ? data : new Uint8Array(data));
    }
    close() {
      if (handle.closed) return;
      handle.closed = true;
      // A real socket reports its own close, and the session's handler is what
      // clears the last of its state.
      queueMicrotask(() => handle.emit("close", {}));
    }
  }

  handle.emit = (type, ev) => {
    for (const fn of handle.listeners.get(type) || []) fn(ev);
  };
  /** Push a frame at the session, as the room would. */
  handle.push = (bytes) => {
    const copy = new Uint8Array(bytes);
    handle.emit("message", { data: copy.buffer });
  };
  /** The binary frames the session has sent, ignoring keep-alive pings. */
  handle.frames = () => handle.sent.filter((f) => typeof f !== "string");

  const real = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  handle.restore = () => {
    globalThis.WebSocket = real;
  };
  return handle;
}

/** Join, with the room admitting us and naming who is in the roster. */
async function joinedSession(ws, { doc = LESSON, participants } = {}) {
  const joining = joinSession({
    url: "wss://example.test/collab/ABC",
    code: "ABC",
  });
  ws.push(new Uint8Array([T.HELLO, 0, 1, 0])); // slot 1, not host
  ws.push(
    frameJson(T.PRESENCE, {
      participants: participants || [
        { slot: 0, name: "Teacher", host: true },
        { slot: 1, name: "Assistant", host: false },
      ],
      requests: [],
    }),
  );
  ws.push(frameBytes(T.ADMITTED, seedUpdate(doc)));
  return joining;
}

test("a session waits to be admitted, then holds the room's lesson", async () => {
  const ws = fakeSocket();
  try {
    const session = await joinedSession(ws);

    assert.equal(ws.url, "wss://example.test/collab/ABC");
    assert.equal(session.doc().title, "Volcanoes");
    assert.equal(session.doc().sections[0].blocks.length, 2);
    assert.deepEqual(
      session.participants.map((p) => p.name),
      ["Teacher", "Assistant"],
    );

    session.close("done");
  } finally {
    ws.restore();
  }
});

test("arriving as host means the code named no live session", async () => {
  // The room creates a session for a host rather than 404ing, so joining a dead
  // code would otherwise leave the assistant alone in a room it invented, quietly
  // reporting success.
  const ws = fakeSocket();
  try {
    const joining = joinSession({
      url: "wss://example.test/collab/GONE",
      code: "GONE",
    });
    ws.push(new Uint8Array([T.HELLO, 0, 0, 1])); // host = 1

    await assert.rejects(joining, /No live session is running/);
  } finally {
    ws.restore();
  }
});

test("a declined request says so rather than timing out", async () => {
  const ws = fakeSocket();
  try {
    const joining = joinSession({
      url: "wss://example.test/collab/ABC",
      code: "ABC",
    });
    ws.push(new Uint8Array([T.HELLO, 0, 1, 0]));
    ws.push(frameBytes(T.REMOVED, new TextEncoder().encode("removed")));

    await assert.rejects(joining, /declined the request to join/);
  } finally {
    ws.restore();
  }
});

test("a close before admission explains itself", async () => {
  // The Worker rejects an unauthenticated or unknown-code upgrade by closing the
  // socket; there is no frame for it.
  const ws = fakeSocket();
  try {
    const joining = joinSession({
      url: "wss://example.test/collab/ABC",
      code: "ABC",
    });
    ws.emit("close", {});

    await assert.rejects(joining, /Couldn't join the collaboration session/);
  } finally {
    ws.restore();
  }
});

test("an edit is sent as one update, and merges with an edit made at the same time", async () => {
  // The property the whole feature rests on: the assistant writing one part of
  // the lesson while the teacher writes another costs neither of them their
  // work. Both replicas start from the same admitted state, edit different
  // fields, and each keeps both changes.
  const ws = fakeSocket();
  try {
    const seed = seedUpdate(LESSON);
    const joining = joinSession({
      url: "wss://example.test/collab/ABC",
      code: "ABC",
    });
    ws.push(new Uint8Array([T.HELLO, 0, 1, 0]));
    ws.push(frameBytes(T.ADMITTED, seed));
    const session = await joining;

    // The teacher's replica, from the same history.
    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, seed);

    const before = ws.frames().length;
    session.edit((doc) => ({ ...doc, title: "Volcanoes and lava" }));

    const sent = ws.frames().slice(before);
    assert.equal(sent.length, 1, "one update, not one per changed field");
    assert.equal(frameType(sent[0]), T.UPDATE);

    // Meanwhile they rewrite a paragraph, and the room relays it to us.
    reconcile(theirs, {
      ...LESSON,
      sections: [
        {
          ...LESSON.sections[0],
          blocks: [
            { id: "b1", type: "text", text: "A volcano ERUPTS violently." },
            LESSON.sections[0].blocks[1],
          ],
        },
      ],
    });
    ws.push(frameBytes(T.UPDATE, Y.encodeStateAsUpdate(theirs)));

    const merged = session.doc();
    assert.equal(merged.title, "Volcanoes and lava", "our edit survived");
    assert.equal(
      merged.sections[0].blocks[0].text,
      "A volcano ERUPTS violently.",
      "and so did theirs",
    );

    session.close("done");
  } finally {
    ws.restore();
  }
});

test("an edit received from the room is not echoed back to it", async () => {
  // Y.applyUpdate tagged REMOTE must not re-enter the update handler's send
  // path, or two peers ping-pong the same edit forever.
  const ws = fakeSocket();
  try {
    // Built from the same admitted state, so this is a genuine replica of the
    // room rather than an unrelated document whose writes race ours on client
    // id — see the merge test above.
    const seed = seedUpdate(LESSON);
    const joining = joinSession({
      url: "wss://example.test/collab/ABC",
      code: "ABC",
    });
    ws.push(new Uint8Array([T.HELLO, 0, 1, 0]));
    ws.push(frameBytes(T.ADMITTED, seed));
    const session = await joining;
    const before = ws.frames().length;

    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, seed);
    reconcile(theirs, { ...LESSON, title: "Theirs" });
    ws.push(frameBytes(T.UPDATE, Y.encodeStateAsUpdate(theirs)));

    assert.equal(session.doc().title, "Theirs");
    assert.equal(ws.frames().length, before, "nothing was sent back");

    session.close("done");
  } finally {
    ws.restore();
  }
});

test("chat is collected and drained, and the sender is named from the roster", async () => {
  const ws = fakeSocket();
  try {
    const session = await joinedSession(ws);

    ws.push(
      frameWithSlot(
        T.CHAT,
        0,
        new TextEncoder().encode(
          JSON.stringify({ text: "Can you do section 2?", ts: 1700000000000 }),
        ),
      ),
    );

    const chat = session.drainChat();
    assert.equal(chat.length, 1);
    assert.equal(chat[0].from, "Teacher");
    assert.equal(chat[0].text, "Can you do section 2?");
    assert.deepEqual(session.drainChat(), [], "drained, not repeated");

    session.close("done");
  } finally {
    ws.restore();
  }
});

test("a cursor marks the block it is in as somebody else's", async () => {
  const ws = fakeSocket();
  try {
    const session = await joinedSession(ws);

    ws.push(
      frameWithSlot(
        T.CURSOR,
        0,
        new TextEncoder().encode(JSON.stringify({ field: "b1", start: 3 })),
      ),
    );

    const busy = session.busyBlocks();
    assert.equal(busy.get("b1"), "Teacher");
    assert.equal(busy.has("b2"), false);

    session.close("done");
  } finally {
    ws.restore();
  }
});

// ---- the tools ---------------------------------------------------------------

async function connect({ live }) {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, {
    api: {},
    config: { apiUrl: "https://example.test" },
    auth: {
      async getAccessToken() {
        return "jwt";
      },
    },
    live,
  });
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    async names() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    async call(name, args) {
      return client.callTool({ name, arguments: args || {} });
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test("the session tools exist only where a transport can hold a session open", async () => {
  const stdio = await connect({ live: true });
  const names = await stdio.names();
  for (const name of [
    "join_collab_session",
    "read_collab_doc",
    "edit_collab_doc",
    "send_collab_chat",
    "leave_collab_session",
  ]) {
    assert.ok(names.includes(name), `stdio has ${name}`);
  }
  await stdio.close();

  // The Worker builds a fresh server per request, so a session could never
  // survive between calls. Better absent than advertised and broken.
  const remote = await connect({ live: false });
  const remoteNames = await remote.names();
  assert.equal(remoteNames.includes("join_collab_session"), false);
  assert.ok(remoteNames.includes("create_lesson"), "everything else is there");
  await remote.close();
});

test("joining declares which assistant is connecting", async () => {
  // Without this the assistant arrives wearing the account holder's display
  // name, and the host sees two cursors called the same thing with no way to
  // tell which one is a person.
  const ws = fakeSocket();
  const mcp = await connect({ live: true });
  try {
    const joining = mcp.call("join_collab_session", { code: "ABC" });
    await new Promise((r) => setTimeout(r, 0));

    const url = new URL(ws.url);
    assert.equal(url.searchParams.get("assistant"), "test");
    assert.equal(url.searchParams.get("token"), "jwt");

    // Let the join fail so the test doesn't sit on the admission timer.
    ws.emit("close", {});
    await joining;
  } finally {
    await mcp.close();
    ws.restore();
  }
});

test("the session tools say what to do when there is no session", async () => {
  const mcp = await connect({ live: true });

  const read = await mcp.call("read_collab_doc");
  assert.equal(read.isError, true);
  assert.match(read.content[0].text, /Not in a collaboration session/);
  assert.match(read.content[0].text, /patch_lesson/);

  const left = await mcp.call("leave_collab_session");
  assert.equal(left.isError, undefined, "leaving nothing is not an error");
  assert.match(left.content[0].text, /nothing to leave/);

  await mcp.close();
});

test("edit_collab_doc refuses a block somebody else's cursor is in", async () => {
  const ws = fakeSocket();
  const mcp = await connect({ live: true });
  try {
    const joining = mcp.call("join_collab_session", { code: "ABC" });
    // Let the tool open the socket before the room answers.
    await new Promise((r) => setTimeout(r, 0));
    ws.push(new Uint8Array([T.HELLO, 0, 1, 0]));
    ws.push(
      frameJson(T.PRESENCE, {
        participants: [
          { slot: 0, name: "Teacher", host: true },
          { slot: 1, name: "Assistant", host: false },
        ],
        requests: [],
      }),
    );
    ws.push(frameBytes(T.ADMITTED, seedUpdate(LESSON)));
    const joined = await joining;
    assert.equal(joined.isError, undefined, joined.content?.[0]?.text);

    // The teacher's caret is in b1.
    ws.push(
      frameWithSlot(
        T.CURSOR,
        0,
        new TextEncoder().encode(JSON.stringify({ field: "b1" })),
      ),
    );

    const clash = await mcp.call("edit_collab_doc", {
      operations: [
        {
          op: "replace_block",
          blockId: "b1",
          block: { type: "text", text: "Rewritten." },
        },
      ],
    });
    assert.equal(clash.isError, true);
    assert.match(clash.content[0].text, /cursor is in/);
    assert.match(clash.content[0].text, /Teacher/);

    // A different block is fine, and lands in the shared document.
    const ok = await mcp.call("edit_collab_doc", {
      operations: [
        {
          op: "replace_block",
          blockId: "b2",
          block: { type: "text", text: "MAGMA rises quickly." },
        },
      ],
    });
    assert.equal(ok.isError, undefined, ok.content?.[0]?.text);
    const payload = JSON.parse(ok.content[0].text);
    assert.equal(payload.applied, 1);
    assert.match(payload.note, /NOT saved/);

    const doc = JSON.parse(
      (await mcp.call("read_collab_doc")).content[0].text,
    ).doc;
    assert.equal(doc.sections[0].blocks[1].text, "MAGMA rises quickly.");

    // Leave, or the session's keep-alive interval outlives the test file and
    // node never exits. (In stdio that interval is the point — it is what stops
    // the room dropping an idle assistant — and the process ends with the
    // client, so it only matters here.)
    const left = await mcp.call("leave_collab_session");
    assert.match(left.content[0].text, /Left session "ABC"/);
  } finally {
    await mcp.close();
    ws.restore();
  }
});
