// Tests for the plain-JSON <-> Yjs bridge that backs live collaboration.
//
// Two properties matter more than the rest, and most of what's below exists to
// pin them down:
//
//   1. Idempotency. Reconciling against an unchanged document must emit no Yjs
//      update. The sync loop (local edit -> reconcile -> send; receive -> apply
//      -> setDoc -> reconcile) only terminates because that second reconcile is
//      a no-op. If this breaks, two peers ping-pong updates forever.
//
//   2. Convergence. Two peers that make different edits and exchange updates
//      must end up with byte-identical documents, whichever order they merge in.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  LOCAL,
  applyRemote,
  docFromY,
  encodeState,
  reconcile,
} from "./ydoc.js";

// A peer: a Y.Doc plus the updates it has emitted for broadcast.
function peer() {
  const ydoc = new Y.Doc();
  const outbox = [];
  ydoc.on("update", (update, origin) => {
    if (origin === LOCAL) outbox.push(update);
  });
  return { ydoc, outbox };
}

// Everything a peer has queued, delivered to another peer.
function flush(from, to) {
  for (const update of from.outbox) applyRemote(to.ydoc, update);
  from.outbox.length = 0;
}

// A second peer joining a room: seeded from the host's current state, exactly as
// an admitted guest is.
function join(host) {
  const guest = peer();
  applyRemote(guest.ydoc, encodeState(host.ydoc));
  return guest;
}

const lesson = () => ({
  title: "Week 1",
  sections: [
    {
      id: "s1",
      name: "Warm up",
      blocks: [
        { id: "b1", type: "text", text: "Read the words aloud." },
        { id: "b2", type: "spelling", words: [{ id: "w1", text: "cat" }] },
      ],
    },
    {
      id: "s2",
      name: "Practice",
      blocks: [
        {
          id: "b3",
          type: "question",
          questionType: "single",
          prompt: "Spell it",
          answer: "cat",
        },
      ],
    },
  ],
  trustedCollaborators: [{ email: "co@school.org", name: "Sam" }],
});

describe("round-trip", () => {
  it("reproduces the document exactly", () => {
    const a = peer();
    const doc = lesson();
    reconcile(a.ydoc, doc);
    expect(docFromY(a.ydoc)).toEqual(doc);
  });

  it("preserves the arbitrary passthrough fields on an image block", () => {
    // jsonImport spreads unknown fields onto image blocks, so the bridge has to
    // be generic rather than aware of a fixed schema.
    const a = peer();
    const doc = {
      title: "T",
      sections: [
        {
          id: "s1",
          name: "S",
          blocks: [
            {
              id: "b1",
              type: "image",
              image: { hash: "abc", mime: "image/webp" },
              size: 60,
              align: "center",
              caption: "A cat",
            },
          ],
        },
      ],
    };
    reconcile(a.ydoc, doc);
    expect(docFromY(a.ydoc)).toEqual(doc);
  });
});

describe("idempotency", () => {
  it("emits nothing when reconciling an unchanged document", () => {
    const a = peer();
    const doc = lesson();
    reconcile(a.ydoc, doc);
    a.outbox.length = 0;

    reconcile(a.ydoc, doc);
    expect(a.outbox).toHaveLength(0);
  });

  it("emits nothing for a deep-equal but distinct object", () => {
    // This is the shape React actually hands us: setDoc produces a fresh object
    // tree on every edit, so identity comparison is worthless here.
    const a = peer();
    reconcile(a.ydoc, lesson());
    a.outbox.length = 0;

    reconcile(a.ydoc, lesson());
    expect(a.outbox).toHaveLength(0);
  });

  it("terminates the receive -> setDoc -> reconcile cycle", () => {
    // The loop that would hang the app if reconcile were not idempotent: a peer
    // applies a remote update, re-renders, and pushes the resulting plain doc
    // straight back through reconcile. That must not produce an update.
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const edited = lesson();
    edited.sections[0].blocks[0].text = "Changed";
    reconcile(host.ydoc, edited);
    flush(host, guest);

    guest.outbox.length = 0;
    reconcile(guest.ydoc, docFromY(guest.ydoc)); // what onRemoteDoc -> setDoc triggers
    expect(guest.outbox).toHaveLength(0);
  });
});

describe("convergence", () => {
  it("merges concurrent edits to different blocks", () => {
    // The bug this whole migration exists to fix: under last-write-wins, one of
    // these two edits was silently lost.
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const hostDoc = lesson();
    hostDoc.sections[0].blocks[0].text = "Host edited this";
    reconcile(host.ydoc, hostDoc);

    const guestDoc = lesson();
    guestDoc.sections[1].blocks[0].prompt = "Guest edited this";
    reconcile(guest.ydoc, guestDoc);

    flush(host, guest);
    flush(guest, host);

    const merged = docFromY(host.ydoc);
    expect(docFromY(guest.ydoc)).toEqual(merged);
    expect(merged.sections[0].blocks[0].text).toBe("Host edited this");
    expect(merged.sections[1].blocks[0].prompt).toBe("Guest edited this");
  });

  it("merges concurrent edits to different fields of the same block", () => {
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const hostDoc = lesson();
    hostDoc.sections[1].blocks[0].prompt = "New prompt";
    reconcile(host.ydoc, hostDoc);

    const guestDoc = lesson();
    guestDoc.sections[1].blocks[0].answer = "kitten";
    reconcile(guest.ydoc, guestDoc);

    flush(host, guest);
    flush(guest, host);

    const merged = docFromY(host.ydoc);
    expect(docFromY(guest.ydoc)).toEqual(merged);
    expect(merged.sections[1].blocks[0].prompt).toBe("New prompt");
    expect(merged.sections[1].blocks[0].answer).toBe("kitten");
  });

  it("keeps both blocks when two people append at once", () => {
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const hostDoc = lesson();
    hostDoc.sections[0].blocks.push({
      id: "hb",
      type: "text",
      text: "from host",
    });
    reconcile(host.ydoc, hostDoc);

    const guestDoc = lesson();
    guestDoc.sections[0].blocks.push({
      id: "gb",
      type: "text",
      text: "from guest",
    });
    reconcile(guest.ydoc, guestDoc);

    flush(host, guest);
    flush(guest, host);

    const ids = docFromY(host.ydoc).sections[0].blocks.map((b) => b.id);
    expect(docFromY(guest.ydoc)).toEqual(docFromY(host.ydoc));
    expect(ids).toContain("hb");
    expect(ids).toContain("gb");
  });

  it("merges a delete against an edit elsewhere", () => {
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const hostDoc = lesson();
    hostDoc.sections[0].blocks = hostDoc.sections[0].blocks.filter(
      (b) => b.id !== "b2",
    );
    reconcile(host.ydoc, hostDoc);

    const guestDoc = lesson();
    guestDoc.sections[0].blocks[0].text = "still here";
    reconcile(guest.ydoc, guestDoc);

    flush(host, guest);
    flush(guest, host);

    const merged = docFromY(host.ydoc);
    expect(docFromY(guest.ydoc)).toEqual(merged);
    expect(merged.sections[0].blocks.map((b) => b.id)).toEqual(["b1"]);
    expect(merged.sections[0].blocks[0].text).toBe("still here");
  });

  it("merges a nested list edit (spelling words)", () => {
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const hostDoc = lesson();
    hostDoc.sections[0].blocks[1].words.push({ id: "w2", text: "dog" });
    reconcile(host.ydoc, hostDoc);

    const guestDoc = lesson();
    guestDoc.sections[0].blocks[1].words[0].text = "cats";
    reconcile(guest.ydoc, guestDoc);

    flush(host, guest);
    flush(guest, host);

    const words = docFromY(host.ydoc).sections[0].blocks[1].words;
    expect(docFromY(guest.ydoc)).toEqual(docFromY(host.ydoc));
    expect(words).toHaveLength(2);
    expect(words.find((w) => w.id === "w1").text).toBe("cats");
    expect(words.find((w) => w.id === "w2").text).toBe("dog");
  });

  it("keys trusted collaborators by email, not position", () => {
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const hostDoc = lesson();
    hostDoc.trustedCollaborators.push({ email: "new@school.org", name: "Ada" });
    reconcile(host.ydoc, hostDoc);

    const guestDoc = lesson();
    guestDoc.trustedCollaborators[0].name = "Samantha";
    reconcile(guest.ydoc, guestDoc);

    flush(host, guest);
    flush(guest, host);

    const list = docFromY(host.ydoc).trustedCollaborators;
    expect(docFromY(guest.ydoc)).toEqual(docFromY(host.ydoc));
    expect(list).toHaveLength(2);
    expect(list.find((t) => t.email === "co@school.org").name).toBe("Samantha");
  });
});

describe("reordering", () => {
  it("applies a local reorder", () => {
    const a = peer();
    reconcile(a.ydoc, lesson());

    const doc = lesson();
    doc.sections[0].blocks.reverse();
    reconcile(a.ydoc, doc);

    expect(docFromY(a.ydoc).sections[0].blocks.map((b) => b.id)).toEqual([
      "b2",
      "b1",
    ]);
  });

  it("does not duplicate a block when two people reorder at once", () => {
    // Yjs has no move operation, so a reorder is delete + insert. Two concurrent
    // reorders of the same list therefore merge into two surviving inserts — the
    // block appears twice. The bridge has to heal that, or drag-and-drop during
    // a session would visibly duplicate content.
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const hostDoc = lesson();
    hostDoc.sections[0].blocks.reverse();
    reconcile(host.ydoc, hostDoc);

    const guestDoc = lesson();
    guestDoc.sections[0].blocks.reverse();
    reconcile(guest.ydoc, guestDoc);

    flush(host, guest);
    flush(guest, host);

    const ids = docFromY(host.ydoc).sections[0].blocks.map((b) => b.id);
    expect(ids).toHaveLength(2);
    expect([...ids].sort()).toEqual(["b1", "b2"]);
    expect(
      docFromY(guest.ydoc).sections[0].blocks.map((b) => b.id),
    ).toHaveLength(2);
  });

  it("keeps an edit made to a block that someone else moved", () => {
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const hostDoc = lesson();
    hostDoc.sections[0].blocks.reverse();
    reconcile(host.ydoc, hostDoc);

    const guestDoc = lesson();
    guestDoc.sections[0].blocks[0].text = "edited while moving";
    reconcile(guest.ydoc, guestDoc);

    flush(host, guest);
    flush(guest, host);

    const merged = docFromY(host.ydoc);
    expect(docFromY(guest.ydoc)).toEqual(merged);
    expect(merged.sections[0].blocks.find((b) => b.id === "b1").text).toBe(
      "edited while moving",
    );
  });
});

describe("known limits", () => {
  it("is last-write-wins when two people edit the same field", () => {
    // Documented, deliberate: text is a plain string, not a Y.Text. Different
    // blocks merge; the same field does not. Upgrading this means making the
    // scalar path in reconcileKey produce a Y.Text.
    const host = peer();
    reconcile(host.ydoc, lesson());
    const guest = join(host);

    const hostDoc = lesson();
    hostDoc.sections[0].blocks[0].text = "host version";
    reconcile(host.ydoc, hostDoc);

    const guestDoc = lesson();
    guestDoc.sections[0].blocks[0].text = "guest version";
    reconcile(guest.ydoc, guestDoc);

    flush(host, guest);
    flush(guest, host);

    const merged = docFromY(host.ydoc);
    expect(docFromY(guest.ydoc)).toEqual(merged);
    // One of the two wins outright — but both peers agree on which.
    expect(["host version", "guest version"]).toContain(
      merged.sections[0].blocks[0].text,
    );
  });
});
