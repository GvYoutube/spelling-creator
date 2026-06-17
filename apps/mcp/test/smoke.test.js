// Smoke tests: the doc builder produces the canonical shapes the editor expects,
// rejects bad input clearly, and the MCP server exposes the full tool set.
// No network — handlers aren't invoked here.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAuth } from "../src/auth.js";
import { buildDoc, lessonWarnings } from "../src/doc.js";
import { applyPatch } from "../src/patch.js";
import { registerTools, SERVER_INFO } from "../src/tools.js";

test("buildDoc maps every block type to the stored shape with ids", () => {
  const doc = buildDoc({
    title: "Volcanoes",
    sections: [
      {
        name: "Reading",
        blocks: [
          { type: "text", text: "A volcano ERUPTS." },
          { type: "spelling", words: ["ERUPTS", " magma "] },
          {
            type: "question",
            questionType: "number",
            prompt: "How many?",
            answer: 3,
          },
          {
            type: "question",
            questionType: "single",
            prompt: "Name one",
            answer: "lava",
          },
          {
            type: "question",
            questionType: "multiple",
            prompt: "Pick",
            answers: ["ash", "lava"],
          },
          {
            type: "question",
            questionType: "open",
            prompt: "Explain",
          },
          {
            type: "question",
            questionType: "background",
            prompt: "Why?",
            background: "ctx",
            answer: "heat",
          },
        ],
      },
    ],
  });

  assert.equal(doc.title, "Volcanoes");
  assert.equal(doc.sections.length, 1);
  const section = doc.sections[0];
  assert.ok(section.id, "section has an id");
  assert.equal(section.name, "Reading");

  const [textB, spellB, numB, singleB, multiB, openB, bgB] = section.blocks;

  assert.equal(textB.type, "text");
  assert.equal(textB.text, "A volcano ERUPTS.");
  assert.ok(textB.id);

  assert.equal(spellB.type, "spelling");
  assert.deepEqual(
    spellB.words.map((w) => w.text),
    ["ERUPTS", "magma"],
  );
  assert.ok(spellB.words.every((w) => w.id));

  assert.equal(numB.answer, "3", "number answer is stringified");
  assert.equal(singleB.answer, "lava");
  assert.deepEqual(
    multiB.answers.map((a) => a.text),
    ["ash", "lava"],
  );
  assert.equal(openB.type, "question");
  assert.equal(openB.questionType, "open");
  assert.equal(openB.prompt, "Explain");
  assert.equal(bgB.background, "ctx");
  assert.equal(bgB.answer, "heat");

  // Every id is unique.
  const ids = [section.id, ...section.blocks.map((b) => b.id)];
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});

test("buildDoc rejects bad input with actionable errors", () => {
  assert.throws(
    () => buildDoc({ title: "x", sections: [] }),
    /at least one section/,
  );
  assert.throws(
    () => buildDoc({ sections: [{ blocks: [{ type: "text" }] }] }),
    /needs a "text" string/,
  );
  assert.throws(
    () =>
      buildDoc({ sections: [{ blocks: [{ type: "spelling", words: [] }] }] }),
    /non-empty "words"/,
  );
  assert.throws(
    () =>
      buildDoc({
        sections: [
          {
            blocks: [{ type: "question", questionType: "single", prompt: "q" }],
          },
        ],
      }),
    /needs an "answer" string/,
  );
  assert.throws(
    () => buildDoc({ sections: [{ blocks: [{ type: "image" }] }] }),
    /image blocks aren't supported/,
  );
  assert.throws(
    () => buildDoc({ sections: [{ blocks: [{ type: "nope" }] }] }),
    /unknown block type/,
  );
});

test("lessonWarnings flags sections that have no question, not ones that do", () => {
  const doc = buildDoc({
    title: "Mix",
    sections: [
      {
        name: "Has a question",
        blocks: [
          { type: "text", text: "WORD here." },
          {
            type: "question",
            questionType: "single",
            prompt: "Q?",
            answer: "a",
          },
        ],
      },
      {
        name: "Just prose",
        blocks: [{ type: "text", text: "No question here." }],
      },
    ],
  });

  const warnings = lessonWarnings(doc);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Just prose/);
  assert.match(warnings[0], /no question/i);
});

test("applyPatch edits by id without touching the original doc", () => {
  const original = buildDoc({
    title: "Original",
    sections: [
      {
        name: "One",
        blocks: [
          { type: "text", text: "First WORD." },
          {
            type: "question",
            questionType: "single",
            prompt: "Q1?",
            answer: "a",
          },
        ],
      },
      { name: "Two", blocks: [{ type: "text", text: "Second." }] },
    ],
  });
  const s0 = original.sections[0].id;
  const blockToReplace = original.sections[0].blocks[0].id;
  const blockToMove = original.sections[0].blocks[1].id;

  const patched = applyPatch(original, [
    { op: "set_title", title: "Renamed" },
    { op: "set_section_name", sectionId: s0, name: "Intro" },
    {
      op: "replace_block",
      blockId: blockToReplace,
      block: { type: "text", text: "Replaced TEXT." },
    },
    {
      op: "add_block",
      sectionId: s0,
      index: 0,
      block: { type: "spelling", words: ["WORD"] },
    },
    {
      op: "move_block",
      blockId: blockToMove,
      sectionId: original.sections[1].id,
    },
  ]);

  // Original is untouched (we only mutate a clone).
  assert.equal(original.title, "Original");
  assert.equal(original.sections[0].name, "One");
  assert.equal(original.sections[0].blocks.length, 2);

  // Patched reflects every op.
  assert.equal(patched.title, "Renamed");
  assert.equal(patched.sections[0].name, "Intro");
  // add_block at index 0 → spelling first, then the replaced text block.
  assert.equal(patched.sections[0].blocks[0].type, "spelling");
  const replaced = patched.sections[0].blocks[1];
  assert.equal(replaced.id, blockToReplace, "replace_block keeps the id");
  assert.equal(replaced.text, "Replaced TEXT.");
  // The question moved to section Two.
  assert.ok(patched.sections[1].blocks.some((b) => b.id === blockToMove));
  assert.ok(!patched.sections[0].blocks.some((b) => b.id === blockToMove));
});

test("applyPatch rejects bad ops and unknown ids", () => {
  const doc = buildDoc({
    title: "T",
    sections: [{ name: "S", blocks: [{ type: "text", text: "x" }] }],
  });
  assert.throws(
    () => applyPatch(doc, [{ op: "remove_section", sectionId: "nope" }]),
    /no section with id/,
  );
  assert.throws(() => applyPatch(doc, [{ op: "frobnicate" }]), /unknown op/);
  // Removing the only section is refused (a lesson needs ≥1).
  assert.throws(
    () =>
      applyPatch(doc, [
        { op: "remove_section", sectionId: doc.sections[0].id },
      ]),
    /at least one/,
  );
});

// An unsigned JWT with a chosen expiry — enough for auth.js's expiry check,
// which only decodes `exp` and never verifies the signature. A future expiry
// means getAccessToken returns it directly without attempting a network refresh.
function fakeJwt(expDeltaSeconds) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expDeltaSeconds;
  return `${part({ alg: "none" })}.${part({ exp })}.sig`;
}

function authConfig(overrides) {
  const dir = mkdtempSync(join(tmpdir(), "scmcp-"));
  return {
    apiUrl: "https://example.test",
    supabaseUrl: "https://supabase.test",
    supabaseAnonKey: "anon",
    accessToken: "",
    refreshToken: "",
    sessionFile: join(dir, "session.json"),
    ...overrides,
  };
}

test("auth continues the rotation chain from the session file for the same seed", async () => {
  const config = authConfig({ refreshToken: "SEED0" });
  const chainToken = fakeJwt(3600);
  writeFileSync(
    config.sessionFile,
    JSON.stringify({
      seed: "SEED0",
      access_token: chainToken,
      refresh_token: "R1",
    }),
  );

  const auth = createAuth(config);
  // Same seed → use the file's (latest, rotated) access token, no network.
  assert.equal(await auth.getAccessToken(), chainToken);
});

test("auth re-seeds (ignores a stale file) when the env refresh token changed", async () => {
  const config = authConfig({
    refreshToken: "NEW",
    accessToken: fakeJwt(3600),
  });
  writeFileSync(
    config.sessionFile,
    JSON.stringify({
      seed: "OLD",
      access_token: fakeJwt(3600),
      refresh_token: "Rold",
    }),
  );

  const auth = createAuth(config);
  // File belongs to a different seed → it's ignored in favour of the env token.
  assert.equal(await auth.getAccessToken(), config.accessToken);
});

test("the MCP server exposes the full tool set", async () => {
  const server = new McpServer(SERVER_INFO);
  // tools/list never calls handlers, so stub ctx is fine.
  registerTools(server, {
    api: {},
    config: { apiUrl: "https://example.test" },
  });

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "create_lesson",
    "create_lesson_file",
    "delete_lesson",
    "get_lesson",
    "list_hub_lessons",
    "list_my_lessons",
    "patch_lesson",
    "set_lesson_published",
    "update_lesson",
    "whoami",
  ]);

  await client.close();
  await server.close();
});

test("create_lesson surfaces soft warnings in its result", async () => {
  const server = new McpServer(SERVER_INFO);
  // Stub api: pretend the save succeeded so we can inspect the result payload.
  const api = {
    async createLesson({ title }) {
      return {
        id: "L1",
        title,
        sectionCount: 1,
        published: false,
        createdAt: "now",
      };
    },
  };
  registerTools(server, { api, config: { apiUrl: "https://example.test" } });

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const res = await client.callTool({
    name: "create_lesson",
    arguments: {
      title: "T",
      sections: [
        { name: "Prose only", blocks: [{ type: "text", text: "no q" }] },
      ],
    },
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(res.isError, undefined); // saved fine — warning is non-blocking
  assert.equal(payload.warnings.length, 1);
  assert.match(payload.warnings[0], /Prose only/);

  await client.close();
  await server.close();
});

test("create_lesson_file builds an importable lesson file offline", async () => {
  const server = new McpServer(SERVER_INFO);
  // No api needed — the tool never touches the network. Pass a throwing stub to
  // prove that.
  const api = new Proxy(
    {},
    {
      get() {
        throw new Error("create_lesson_file must not call the API");
      },
    },
  );
  registerTools(server, { api, config: { apiUrl: "https://example.test" } });

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const res = await client.callTool({
    name: "create_lesson_file",
    arguments: {
      title: "Volcanoes!",
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
    },
  });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.lessonFile.format, "spelling-creator-lesson");
  assert.equal(payload.lessonFile.version, 1);
  assert.equal(payload.lessonFile.doc.title, "Volcanoes!");
  assert.equal(payload.lessonFile.doc.sections[0].name, "Reading");
  assert.ok(payload.lessonFile.doc.sections[0].blocks[0].id);
  assert.equal(payload.filename, "Volcanoes.json");

  await client.close();
  await server.close();
});

test("patch_lesson fetches, applies the diff, and PUTs the result", async () => {
  const server = new McpServer(SERVER_INFO);
  const stored = buildDoc({
    title: "Before",
    sections: [
      {
        name: "S",
        blocks: [
          { type: "text", text: "OLD text." },
          {
            type: "question",
            questionType: "single",
            prompt: "Q?",
            answer: "a",
          },
        ],
      },
    ],
  });
  const blockId = stored.sections[0].blocks[0].id;
  let putDoc = null;
  const api = {
    async getLesson() {
      return { id: "L1", title: "Before", doc: stored };
    },
    async updateLesson(id, { doc }) {
      putDoc = doc;
      return { id, title: doc.title, sectionCount: doc.sections.length };
    },
  };
  registerTools(server, { api, config: { apiUrl: "https://example.test" } });

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const res = await client.callTool({
    name: "patch_lesson",
    arguments: {
      id: "L1",
      operations: [
        { op: "set_title", title: "After" },
        {
          op: "replace_block",
          blockId,
          block: { type: "text", text: "NEW text." },
        },
      ],
    },
  });

  assert.equal(res.isError, undefined);
  // The PUT received the patched doc — not a client-sent full replacement.
  assert.equal(putDoc.title, "After");
  assert.equal(putDoc.sections[0].blocks[0].text, "NEW text.");
  assert.equal(putDoc.sections[0].blocks[0].id, blockId, "block id preserved");
  // The original stored doc the stub handed out wasn't mutated.
  assert.equal(stored.title, "Before");

  await client.close();
  await server.close();
});
