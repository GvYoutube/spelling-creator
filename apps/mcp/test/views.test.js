// The MCP Apps view surface (src/views.js): that the picker is actually offered
// to a client, that it is offered the way Claude requires, and that turning
// search_images into an app tool didn't cost the text clients anything.
//
// The rendering itself isn't testable from here — that needs a host — so what's
// pinned down is the wiring a host silently refuses to render without: the
// `ui://` resource existing under the mime type hosts look for, the tool
// pointing at it, the sandbox origin, and the CSP entry the thumbnails need.

import assert from "node:assert/strict";
import test from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools, SERVER_INFO } from "../src/tools.js";
import { appDomain, IMAGE_PICKER_URI } from "../src/views.js";

const CONFIG = { apiUrl: "https://example.test" };

async function connected(api = {}) {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, { api, config: CONFIG });
  const client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

test("the image picker is offered as a ui:// resource a host can render", async () => {
  const client = await connected();

  const { resources } = await client.listResources();
  const picker = resources.find((r) => r.uri === IMAGE_PICKER_URI);
  assert.ok(picker, "the picker is listed");
  assert.equal(picker.mimeType, "text/html;profile=mcp-app");

  const { contents } = await client.readResource({ uri: IMAGE_PICKER_URI });
  const [view] = contents;
  assert.equal(view.mimeType, "text/html;profile=mcp-app");
  assert.match(view.text, /<!doctype html>/i);
  // Self-contained: a sandboxed view may not fetch a script at runtime.
  assert.ok(!/<script[^>]+src=/i.test(view.text), "no external script");
});

test("the picker declares the origin and the domains it needs", async () => {
  const client = await connected();
  const { contents } = await client.readResource({ uri: IMAGE_PICKER_URI });
  const ui = contents[0]._meta?.ui;

  assert.equal(ui.domain, await appDomain(`${CONFIG.apiUrl}/mcp`));
  assert.match(ui.domain, /^[0-9a-f]{32}\.claudemcpcontent\.com$/);
  // Commons thumbnails are the whole point of the view; undeclared, they'd be
  // blocked by the sandbox CSP and the picker would render empty frames.
  assert.deepEqual(ui.csp.resourceDomains, ["https://upload.wikimedia.org"]);
});

test("search_images points at the picker, in both meta spellings", async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  const search = tools.find((t) => t.name === "search_images");

  assert.equal(search._meta.ui.resourceUri, IMAGE_PICKER_URI);
  // registerAppTool mirrors the nested key to the flat one older hosts read.
  assert.equal(search._meta["ui/resourceUri"], IMAGE_PICKER_URI);
});

// One Commons search result, in the action API's own shape.
const COMMONS_RESPONSE = {
  query: {
    pages: {
      101: {
        title: "File:Red fox.jpg",
        index: 1,
        imageinfo: [
          {
            mime: "image/jpeg",
            width: 2400,
            height: 1600,
            thumburl: "https://upload.wikimedia.org/thumb/Red_fox.jpg",
            descriptionurl:
              "https://commons.wikimedia.org/wiki/File:Red_fox.jpg",
            extmetadata: {
              Artist: { value: "<a href='#'>A. Photographer</a>" },
              LicenseShortName: { value: "CC BY-SA 4.0" },
            },
          },
        ],
      },
    },
  },
};

async function withCommons(response, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
    });
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("search_images answers in text and in structured content alike", async () => {
  const res = await withCommons(COMMONS_RESPONSE, async () => {
    const client = await connected();
    return client.callTool({
      name: "search_images",
      arguments: { query: "red fox", lessonId: "L1", sectionIndex: 2 },
    });
  });

  // The text block is what it always was: the whole payload, as JSON.
  const fromText = JSON.parse(res.content[0].text);
  assert.deepEqual(res.structuredContent, fromText);

  const [image] = res.structuredContent.images;
  assert.equal(image.ref, "File:Red fox.jpg");
  assert.equal(
    image.previewURL,
    COMMONS_RESPONSE.query.pages[101].imageinfo[0].thumburl,
  );
  assert.match(image.caption, /A\. Photographer/);

  // Told where the picture is going, the tool passes it through so a click in
  // the view can place the image without asking the model anything.
  assert.equal(res.structuredContent.lessonId, "L1");
  assert.deepEqual(res.structuredContent.placement, {
    sectionIndex: 2,
    index: 0,
  });
});

test("a search with no hits still satisfies the tool's output schema", async () => {
  const res = await withCommons({ query: { pages: {} } }, async () => {
    const client = await connected();
    return client.callTool({
      name: "search_images",
      arguments: { query: "no such thing" },
    });
  });

  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /No images found/);
  assert.deepEqual(res.structuredContent.images, []);
});
