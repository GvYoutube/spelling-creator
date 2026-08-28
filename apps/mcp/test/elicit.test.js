// Putting a question to the user mid-tool-call (askUser in src/tools.js).
//
// Three decisions in this server are the user's and were, until this existed,
// made by the model on their behalf: deleting a lesson for good, publishing one
// to the public hub under their name, and overriding the authoring standard with
// skipValidation. The tool descriptions asked the model to check first, which is
// prose it may or may not act on and nobody can audit.
//
// These tests hold three things: that a client which can ask gets the user's
// answer honoured; that a client which cannot behaves exactly as it always did;
// and that a refusal costs only the thing refused — a lesson whose publishing is
// declined is still written, as a draft.

import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { registerTools, SERVER_INFO } from "../src/tools.js";

/**
 * An MCP client wired to the tools.
 *
 * `answer` decides what the user says when asked: a boolean ticks or clears the
 * box on an accepted form, "decline" dismisses the prompt, and null declares no
 * elicitation capability at all — the client most people are running.
 */
async function connect(api, answer) {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, { api, config: { apiUrl: "https://example.test" } });

  const asked = [];
  const client = new Client(
    { name: "test", version: "0" },
    answer === null ? {} : { capabilities: { elicitation: {} } },
  );
  if (answer !== null) {
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      asked.push(request.params.message);
      if (answer === "decline") return { action: "decline" };
      return { action: "accept", content: { confirm: answer } };
    });
  }

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    asked,
    async call(name, args) {
      return client.callTool({ name, arguments: args });
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** A hub stub that records whether the lesson was actually deleted. */
function deletableHub() {
  const state = { deleted: [] };
  return {
    state,
    api: {
      async getLesson() {
        return { id: "L1", title: "Volcanoes", doc: { title: "Volcanoes" } };
      },
      async deleteLesson(id) {
        state.deleted.push(id);
      },
    },
  };
}

test("delete_lesson asks the user, and does not delete when they say no", async () => {
  const hub = deletableHub();
  const mcp = await connect(hub.api, "decline");

  const res = await mcp.call("delete_lesson", { id: "L1" });

  assert.equal(hub.state.deleted.length, 0, "nothing was deleted");
  assert.equal(mcp.asked.length, 1, "the user was asked exactly once");
  // Asked about a lesson, not about an opaque id.
  assert.match(mcp.asked[0], /"Volcanoes"/);
  assert.match(mcp.asked[0], /cannot be undone/);
  // Declining is not an error — but the model must be told to stop rather than
  // to try again.
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /Not deleted/);
  assert.match(res.content[0].text, /said no/);
  assert.match(res.content[0].text, /set_lesson_published\(false\)/);

  await mcp.close();
});

test("an accepted form with the box left unticked is a no, not a yes", async () => {
  // The user can refuse through the form as well as through the buttons, and
  // reading `action: "accept"` alone would delete the lesson they just declined.
  const hub = deletableHub();
  const mcp = await connect(hub.api, false);

  await mcp.call("delete_lesson", { id: "L1" });

  assert.equal(hub.state.deleted.length, 0);

  await mcp.close();
});

test("delete_lesson deletes once the user confirms", async () => {
  const hub = deletableHub();
  const mcp = await connect(hub.api, true);

  const res = await mcp.call("delete_lesson", { id: "L1" });

  assert.deepEqual(hub.state.deleted, ["L1"]);
  assert.match(res.content[0].text, /with the user's confirmation/);

  await mcp.close();
});

test("a client that can't ask deletes exactly as it always did", async () => {
  // Elicitation is optional in the MCP spec and most clients don't implement
  // it. Failing closed here would make the tool unusable on them.
  const hub = deletableHub();
  const mcp = await connect(hub.api, null);

  const res = await mcp.call("delete_lesson", { id: "L1" });

  assert.deepEqual(hub.state.deleted, ["L1"]);
  assert.equal(res.isError, undefined);
  assert.doesNotMatch(res.content[0].text, /confirmation/);

  await mcp.close();
});

test("a lesson whose title can't be read is still deletable", async () => {
  // The title is only there to make the question readable; failing to fetch it
  // must not block a deletion the user asked for.
  const state = { deleted: [] };
  const api = {
    async getLesson() {
      throw new Error("hub is down");
    },
    async deleteLesson(id) {
      state.deleted.push(id);
    },
  };
  const mcp = await connect(api, true);

  await mcp.call("delete_lesson", { id: "L7" });

  assert.deepEqual(state.deleted, ["L7"]);
  assert.match(mcp.asked[0], /`L7`/, "falls back to the id");

  await mcp.close();
});

// A lesson whose green answer is nowhere in its own passage, so skipValidation
// is genuinely suppressing something.
const UNGROUNDED_LESSON = {
  title: "T",
  sections: [
    {
      name: "Reading",
      blocks: [
        { type: "text", text: "A volcano ERUPTS." },
        {
          type: "question",
          questionType: "single",
          prompt: "What flows?",
          answer: "obsidian",
        },
      ],
    },
  ],
};

test("skipValidation asks the user to approve the override, naming what it waives", async () => {
  const saved = [];
  const api = {
    async createLesson({ title }) {
      saved.push(title);
      return { id: "L9", title, sectionCount: 1, published: false };
    },
  };
  const mcp = await connect(api, "decline");

  const res = await mcp.call("create_lesson", {
    ...UNGROUNDED_LESSON,
    skipValidation: true,
  });

  assert.equal(saved.length, 0, "nothing was saved");
  assert.equal(mcp.asked.length, 1);
  // The user is told what they would be waiving, not just that something is off.
  assert.match(mcp.asked[0], /breaks the authoring standard in 1 way/);
  assert.match(mcp.asked[0], /obsidian/);
  // A refused override is a failed write, so the model gets an error it can act
  // on — and is told not to keep asking.
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /said no/);
  assert.match(
    res.content[0].text,
    /Do not call the tool again with skipValidation/,
  );

  await mcp.close();
});

test("skipValidation saves once the user approves it", async () => {
  const saved = [];
  const api = {
    async createLesson({ title }) {
      saved.push(title);
      return { id: "L9", title, sectionCount: 1, published: false };
    },
  };
  const mcp = await connect(api, true);

  const res = await mcp.call("create_lesson", {
    ...UNGROUNDED_LESSON,
    skipValidation: true,
  });

  assert.equal(res.isError, undefined);
  assert.deepEqual(saved, ["T"]);
  // Skipping the check still skips the warnings with it — nothing was reported.
  assert.equal(JSON.parse(res.content[0].text).warnings, undefined);

  await mcp.close();
});

test("skipValidation asks nothing when the lesson breaks no rule anyway", async () => {
  // The flag is often set defensively. There is nothing to waive here, so there
  // is no reason to interrupt anybody.
  const api = {
    async createLesson({ title }) {
      return { id: "L1", title, sectionCount: 1, published: false };
    },
  };
  const mcp = await connect(api, true);

  await mcp.call("create_lesson", {
    title: "Volcanoes",
    sections: [
      {
        name: "Reading",
        blocks: [
          { type: "text", text: "A volcano ERUPTS." },
          {
            type: "question",
            questionType: "single",
            prompt: "What erupts?",
            answer: "volcano",
          },
        ],
      },
    ],
    skipValidation: true,
  });

  assert.equal(mcp.asked.length, 0);

  await mcp.close();
});

// A grounded one-section lesson, so nothing but publishing is ever in question.
const GOOD_LESSON = {
  title: "Volcanoes",
  sections: [
    {
      name: "Reading",
      blocks: [
        { type: "text", text: "A volcano ERUPTS." },
        {
          type: "question",
          questionType: "single",
          prompt: "What erupts?",
          answer: "volcano",
        },
      ],
    },
  ],
};

test("create_lesson asks before a new lesson goes public", async () => {
  const written = [];
  const api = {
    async createLesson({ title, published }) {
      written.push({ title, published });
      return { id: "L1", title, sectionCount: 1, published };
    },
  };
  const mcp = await connect(api, true);

  await mcp.call("create_lesson", { ...GOOD_LESSON, published: true });

  assert.equal(mcp.asked.length, 1);
  assert.match(mcp.asked[0], /"Volcanoes"/);
  assert.match(mcp.asked[0], /read, copy and fork/);
  assert.equal(written[0].published, true);

  await mcp.close();
});

test("refusing to publish saves a private draft instead of losing the lesson", async () => {
  // The user said no to publishing, not to the lesson. Failing the write would
  // throw away everything the assistant just composed.
  const written = [];
  const api = {
    async createLesson({ title, published }) {
      written.push({ title, published });
      return { id: "L1", title, sectionCount: 1, published };
    },
  };
  const mcp = await connect(api, "decline");

  const res = await mcp.call("create_lesson", {
    ...GOOD_LESSON,
    published: true,
  });

  assert.equal(res.isError, undefined, "the lesson was still created");
  assert.equal(written.length, 1);
  assert.equal(written[0].published, false, "created as a draft");
  const payload = JSON.parse(res.content[0].text);
  assert.match(payload.note, /PRIVATE DRAFT/);
  assert.match(payload.note, /said no/);

  await mcp.close();
});

test("create_lesson asks nothing when the lesson stays a draft", async () => {
  const api = {
    async createLesson({ title, published }) {
      return { id: "L1", title, sectionCount: 1, published };
    },
  };
  const mcp = await connect(api, true);

  await mcp.call("create_lesson", GOOD_LESSON);

  assert.equal(mcp.asked.length, 0);

  await mcp.close();
});

test("set_lesson_published asks on the way out and not on the way back", async () => {
  const written = [];
  const api = {
    async getLesson() {
      return {
        id: "L1",
        title: "Volcanoes",
        doc: { title: "Volcanoes" },
        published: false,
      };
    },
    async updateLesson(id, { published }) {
      written.push(published);
      return { id, title: "Volcanoes", sectionCount: 1, published };
    },
  };

  const refused = await connect(api, "decline");
  const res = await refused.call("set_lesson_published", {
    id: "L1",
    published: true,
  });
  assert.equal(written.length, 0, "nothing was written");
  assert.match(res.content[0].text, /Not published/);
  assert.match(res.content[0].text, /still a private draft/);
  await refused.close();

  // Unpublishing only ever makes a lesson less visible, so it is never queried.
  const hiding = await connect(api, "decline");
  await hiding.call("set_lesson_published", { id: "L1", published: false });
  assert.equal(hiding.asked.length, 0);
  assert.deepEqual(written, [false]);
  await hiding.close();
});

test("a lesson that is already public isn't queried again", async () => {
  // Nothing is becoming visible that wasn't, so there is nothing to consent to.
  const api = {
    async getLesson() {
      return {
        id: "L1",
        title: "Volcanoes",
        doc: { title: "Volcanoes" },
        published: true,
      };
    },
    async updateLesson(id, { published }) {
      return { id, title: "Volcanoes", sectionCount: 1, published };
    },
  };
  const mcp = await connect(api, "decline");

  await mcp.call("set_lesson_published", { id: "L1", published: true });

  assert.equal(mcp.asked.length, 0);

  await mcp.close();
});

test("patch_lesson keeps the edit when the user refuses the publish that rode along", async () => {
  // `published` is a rider on a content change here, so a refusal must cost the
  // publishing and nothing else.
  const stored = {
    id: "L1",
    title: "Volcanoes",
    published: false,
    doc: {
      title: "Volcanoes",
      sections: [
        {
          id: "s1",
          name: "Reading",
          blocks: [{ id: "b1", type: "text", text: "A volcano ERUPTS." }],
        },
      ],
    },
  };
  let written = null;
  const api = {
    async getLesson() {
      return stored;
    },
    async updateLesson(id, body) {
      written = body;
      return {
        id,
        title: body.title,
        sectionCount: 1,
        published: body.published,
      };
    },
    async fetchLessonPack() {
      return null;
    },
    async pushLessonPack() {},
    async whoami() {
      return { id: "u1", displayName: "Teacher" };
    },
  };
  const mcp = await connect(api, "decline");

  const res = await mcp.call("patch_lesson", {
    id: "L1",
    operations: [{ op: "set_title", title: "Volcanoes and lava" }],
    published: true,
    skipValidation: true,
  });

  assert.equal(res.isError, undefined);
  assert.equal(written.title, "Volcanoes and lava", "the edit landed");
  assert.equal(written.published, false, "the publishing did not");
  assert.match(JSON.parse(res.content[0].text).note, /still a PRIVATE DRAFT/);

  await mcp.close();
});

test("a client that can't ask still gets the old skipValidation behaviour", async () => {
  const saved = [];
  const api = {
    async createLesson({ title }) {
      saved.push(title);
      return { id: "L9", title, sectionCount: 1, published: false };
    },
  };
  const mcp = await connect(api, null);

  const res = await mcp.call("create_lesson", {
    ...UNGROUNDED_LESSON,
    skipValidation: true,
  });

  assert.equal(res.isError, undefined);
  assert.deepEqual(saved, ["T"], "saved as it always was");

  await mcp.close();
});
