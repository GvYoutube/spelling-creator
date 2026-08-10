// Smoke tests: the doc builder produces the canonical shapes the editor expects,
// rejects bad input clearly, the MCP server exposes the full tool set, and the
// writing tools enforce the authoring standard at the tool boundary. No network —
// the handlers that reach the API run against stubs.
//
// The standard's own rules are tested in validate.test.js; what's here is the
// wiring around them — that a rejection stops the write, that skipValidation
// doesn't, and that a patch is judged only on what it changed.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAuth } from "../src/auth.js";
import { buildDoc } from "../src/doc.js";
import { applyPatch } from "../src/patch.js";
import { registerTools, SERVER_INFO } from "../src/tools.js";
import { validateLesson } from "../src/validate.js";

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
    /must carry an { image: { hash, mime, ext } } reference/,
  );
  assert.throws(
    () => buildDoc({ sections: [{ blocks: [{ type: "nope" }] }] }),
    /unknown block type/,
  );
});

test("validateLesson warns about sections that have no question, not ones that do", () => {
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
            answer: "WORD",
          },
        ],
      },
      {
        name: "Just prose",
        blocks: [{ type: "text", text: "No question here." }],
      },
    ],
  });

  const noQuestion = validateLesson(doc).warnings.filter(
    (w) => w.code === "W_NO_QUESTION",
  );
  assert.equal(noQuestion.length, 1);
  assert.equal(noQuestion[0].section, 2);
  assert.match(noQuestion[0].message, /Just prose/);
  assert.match(noQuestion[0].message, /no question/i);
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

test("buildDoc accepts an image block carrying a stored bytes reference", () => {
  const doc = buildDoc({
    title: "Space",
    sections: [
      {
        name: "Planets",
        blocks: [
          {
            type: "image",
            image: { hash: "abc123", mime: "image/jpeg" },
            width: 800,
            height: 600,
            caption: "Saturn via Wikimedia Commons",
            align: "center",
          },
          {
            type: "question",
            questionType: "single",
            prompt: "Which planet?",
            answer: "Saturn",
          },
        ],
      },
    ],
  });
  const img = doc.sections[0].blocks[0];
  assert.equal(img.type, "image");
  assert.ok(img.id, "image block gets an id");
  assert.deepEqual(img.image, {
    hash: "abc123",
    mime: "image/jpeg",
    ext: "jpg",
  });
  assert.equal(img.width, 800);
  assert.equal(img.caption, "Saturn via Wikimedia Commons");
  assert.equal(img.align, "center");
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
    "add_image",
    "create_lesson",
    "create_lesson_file",
    "delete_lesson",
    "fork_lesson",
    "get_lesson",
    "list_hub_lessons",
    "list_lesson_proposals",
    "list_my_lessons",
    "patch_lesson",
    "propose_changes",
    "search_images",
    "set_lesson_published",
    "update_lesson",
    "whoami",
  ]);

  await client.close();
  await server.close();
});

// A lesson whose green answer is nowhere in its own passage — the defect the
// grounding check exists for.
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

test("create_lesson rejects a lesson that breaks the standard, and saves nothing", async () => {
  const server = new McpServer(SERVER_INFO);
  const api = {
    async createLesson() {
      throw new Error("must not reach the API when validation fails");
    },
  };
  registerTools(server, { api, config: { apiUrl: "https://example.test" } });

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const res = await client.callTool({
    name: "create_lesson",
    arguments: UNGROUNDED_LESSON,
  });

  assert.equal(res.isError, true);
  const message = res.content[0].text;
  assert.match(message, /nothing was saved/);
  assert.match(message, /E_GROUNDING_SINGLE/);
  assert.match(message, /"obsidian"/);
  assert.match(message, /skipValidation/);

  await client.close();
  await server.close();
});

test("skipValidation saves a lesson the standard would reject", async () => {
  const server = new McpServer(SERVER_INFO);
  let saved = null;
  const api = {
    async createLesson({ title }) {
      saved = title;
      return { id: "L9", title, sectionCount: 1, published: false };
    },
  };
  registerTools(server, { api, config: { apiUrl: "https://example.test" } });

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const res = await client.callTool({
    name: "create_lesson",
    arguments: { ...UNGROUNDED_LESSON, skipValidation: true },
  });

  assert.equal(res.isError, undefined);
  assert.equal(saved, "T");
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.id, "L9");
  // Skipping validation skips the warnings too — nothing was checked.
  assert.equal(payload.warnings, undefined);

  await client.close();
  await server.close();
});

// Guards blockSchema's .passthrough(): zod strips unknown keys by default, which
// would drop `exampleAnswer` before any handler saw it — the model would be told
// nothing and would keep sending it.
test("an unknown field on an open question survives the MCP round trip to validation", async () => {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, {
    api: {},
    config: { apiUrl: "https://example.test" },
  });

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const res = await client.callTool({
    name: "create_lesson_file",
    arguments: {
      title: "T",
      sections: [
        {
          name: "S",
          blocks: [
            { type: "text", text: "A river runs." },
            {
              type: "question",
              questionType: "open",
              prompt: "Name a color.",
              exampleAnswer: "blue",
            },
          ],
        },
      ],
    },
  });

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /E_OPEN_HAS_ANSWER/);
  assert.match(res.content[0].text, /exampleAnswer/);

  await client.close();
  await server.close();
});

test("patch_lesson only blocks on defects the patch introduced", async () => {
  const server = new McpServer(SERVER_INFO);
  // The stored lesson is already off-standard: a green answer that isn't in its
  // passage. A patch that doesn't touch it must still go through.
  const stored = buildDoc(UNGROUNDED_LESSON);
  let put = null;
  const api = {
    async getLesson() {
      return { id: "L2", title: "T", doc: stored };
    },
    async updateLesson(id, body) {
      put = body;
      return { id, title: body.title, sectionCount: 1, published: false };
    },
  };
  registerTools(server, { api, config: { apiUrl: "https://example.test" } });

  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const harmless = await client.callTool({
    name: "patch_lesson",
    arguments: {
      id: "L2",
      operations: [{ op: "set_title", title: "Renamed" }],
    },
  });
  assert.equal(harmless.isError, undefined);
  assert.equal(put.title, "Renamed");

  // A patch that adds its own ungrounded answer is rejected, and reports only
  // that one — not the defect it inherited.
  const breaking = await client.callTool({
    name: "patch_lesson",
    arguments: {
      id: "L2",
      operations: [
        {
          op: "add_block",
          sectionId: stored.sections[0].id,
          block: {
            type: "question",
            questionType: "single",
            prompt: "What else?",
            answer: "pumice",
          },
        },
      ],
    },
  });
  assert.equal(breaking.isError, true);
  assert.match(breaking.content[0].text, /"pumice"/);
  assert.doesNotMatch(breaking.content[0].text, /obsidian/);

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
  assert.equal(res.isError, undefined); // saved fine — warnings are non-blocking
  const codes = payload.warnings.map((w) => w.code);
  assert.ok(codes.includes("W_NO_QUESTION"));
  assert.ok(codes.includes("W_SECTION_COUNT"));
  const noQuestion = payload.warnings.find((w) => w.code === "W_NO_QUESTION");
  assert.equal(noQuestion.section, 1);
  assert.match(noQuestion.message, /Prose only/);

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

test("add_image resolves a Commons ref, uploads it, and inserts an image block", async () => {
  const server = new McpServer(SERVER_INFO);
  const stored = buildDoc({
    title: "Space",
    sections: [
      {
        name: "Saturn",
        blocks: [
          { type: "text", text: "SATURN has rings." },
          {
            type: "question",
            questionType: "single",
            prompt: "Which planet?",
            answer: "Saturn",
          },
        ],
      },
    ],
  });

  let uploaded = null;
  let putDoc = null;
  const api = {
    async getLesson() {
      return { id: "L1", title: "Space", doc: stored };
    },
    async uploadImage(bytes, mime) {
      uploaded = { length: bytes.length, mime };
      return { hash: "deadbeef", mime, ext: "jpg" };
    },
    async updateLesson(id, { doc }) {
      putDoc = doc;
      return { id, title: doc.title, sectionCount: doc.sections.length };
    },
  };
  registerTools(server, { api, config: { apiUrl: "https://example.test" } });

  // Mock Commons: the metadata query returns one File page; the image URL
  // returns a few bytes. resolveWikimediaImage hits both in turn.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("commons.wikimedia.org")) {
      return new Response(
        JSON.stringify({
          query: {
            pages: {
              42: {
                title: "File:Saturn.jpg",
                imageinfo: [
                  {
                    thumburl: "https://upload.wikimedia.org/saturn-1600.jpg",
                    url: "https://upload.wikimedia.org/saturn.jpg",
                    thumbwidth: 1600,
                    thumbheight: 1200,
                    width: 4000,
                    height: 3000,
                    mime: "image/jpeg",
                    descriptionurl:
                      "https://commons.wikimedia.org/wiki/File:Saturn.jpg",
                    extmetadata: {
                      Artist: { value: "<a href='#'>NASA</a>" },
                      LicenseShortName: { value: "CC BY 2.0" },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // The image bytes.
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });
  };

  try {
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const res = await client.callTool({
      name: "add_image",
      arguments: { lessonId: "L1", ref: "File:Saturn.jpg", sectionIndex: 0 },
    });

    assert.equal(res.isError, undefined);
    // Bytes were uploaded.
    assert.equal(uploaded.length, 4);
    assert.equal(uploaded.mime, "image/jpeg");
    // The lesson got an image block in section 0, with the attribution — inserted
    // before the trailing question block rather than appended after it.
    const blocks = putDoc.sections[0].blocks;
    assert.equal(blocks.length, 3);
    const img = blocks[1];
    assert.equal(img.type, "image");
    assert.equal(img.image.hash, "deadbeef");
    assert.equal(img.width, 1600);
    assert.match(img.caption, /NASA/);
    assert.match(img.caption, /Wikimedia Commons/);
    assert.equal(blocks[2].type, "question");
    // The result echoes the attribution caption.
    const payload = JSON.parse(res.content[0].text);
    assert.match(payload.caption, /NASA/);

    await client.close();
    await server.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("add_image places the block right after afterBlockId", async () => {
  const server = new McpServer(SERVER_INFO);
  const stored = buildDoc({
    title: "Space",
    sections: [
      {
        name: "Saturn",
        blocks: [
          { type: "text", text: "SATURN has rings." },
          { type: "text", text: "It is a GIANT planet." },
          {
            type: "question",
            questionType: "single",
            prompt: "Which planet?",
            answer: "Saturn",
          },
        ],
      },
    ],
  });
  const firstBlockId = stored.sections[0].blocks[0].id;

  let putDoc = null;
  const api = {
    async getLesson() {
      return { id: "L1", title: "Space", doc: stored };
    },
    async uploadImage(bytes, mime) {
      return { hash: "deadbeef", mime, ext: "jpg" };
    },
    async updateLesson(id, { doc }) {
      putDoc = doc;
      return { id, title: doc.title, sectionCount: doc.sections.length };
    },
  };
  registerTools(server, { api, config: { apiUrl: "https://example.test" } });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("commons.wikimedia.org")) {
      return new Response(
        JSON.stringify({
          query: {
            pages: {
              42: {
                title: "File:Saturn.jpg",
                imageinfo: [
                  {
                    thumburl: "https://upload.wikimedia.org/saturn-1600.jpg",
                    url: "https://upload.wikimedia.org/saturn.jpg",
                    thumbwidth: 1600,
                    thumbheight: 1200,
                    width: 4000,
                    height: 3000,
                    mime: "image/jpeg",
                    descriptionurl:
                      "https://commons.wikimedia.org/wiki/File:Saturn.jpg",
                    extmetadata: {
                      Artist: { value: "<a href='#'>NASA</a>" },
                      LicenseShortName: { value: "CC BY 2.0" },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    });
  };

  try {
    const client = new Client({ name: "test", version: "0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const res = await client.callTool({
      name: "add_image",
      arguments: {
        lessonId: "L1",
        ref: "File:Saturn.jpg",
        afterBlockId: firstBlockId,
      },
    });

    assert.equal(res.isError, undefined);
    const blocks = putDoc.sections[0].blocks;
    assert.equal(blocks.length, 4);
    assert.equal(blocks[0].id, firstBlockId);
    assert.equal(blocks[1].type, "image");
    assert.equal(blocks[2].type, "text");
    assert.equal(blocks[3].type, "question");

    await client.close();
    await server.close();
  } finally {
    globalThis.fetch = realFetch;
  }
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
