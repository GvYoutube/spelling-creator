// The server half of the MCP Apps views — the `ui://` resources a host fetches
// and renders in a sandboxed iframe beside a tool's result. See
// apps/docs/docs/mcp-server/interactive-views.md for the design, and views/ for
// the source the built HTML comes from.
//
// Views are a progressive enhancement, and deliberately the only optional part
// of this server: a host that doesn't negotiate the MCP Apps capability
// (io.modelcontextprotocol/ui) never reads these resources and gets exactly the
// text results it always did. That's why nothing branches on the capability —
// the `_meta.ui` a tool carries is inert to a host that doesn't look for it, so
// registering unconditionally costs a client that can't render anything nothing
// at all, and keeps one code path instead of two.
//
// The HTML reaches both runtimes the same way standards.md does — a package
// subpath import resolved per-runtime (see package.json's "imports"), because
// wrangler's Text module rule matches on a literal relative specifier and Node
// has no text-module loader at all.

import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import imagePickerHtml from "#image-picker-html";
import { sha256Hex } from "./images.js";

// Versioned: hosts cache a `ui://` resource independently of this server, and a
// client still holding the old one must keep working. Bump the number when the
// view's shape changes and serve the old URI alongside it, rather than editing
// what an existing conversation already rendered.
export const IMAGE_PICKER_URI = "ui://spelling-creator/image-picker-1.html";

// Commons thumbnails. A view may load nothing the server hasn't declared, so
// without this the picker renders as a row of broken images.
const IMAGE_HOSTS = ["https://upload.wikimedia.org"];

/**
 * The stable origin Claude gives this server's views, derived from the MCP
 * endpoint URL: sha256(url) truncated to 32 hex chars under claudemcpcontent.com.
 * It's self-computed rather than issued — but Claude wants it declared, and
 * without it the host fetches the resource, reports that a widget rendered, and
 * then shows nothing at all.
 * @param {string} mcpUrl
 */
export async function appDomain(mcpUrl) {
  const digest = await sha256Hex(new TextEncoder().encode(mcpUrl));
  return `${digest.slice(0, 32)}.claudemcpcontent.com`;
}

/**
 * Register every view this server ships.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ apiUrl: string }} config
 */
export function registerViews(server, config) {
  registerAppResource(
    server,
    "Image picker",
    IMAGE_PICKER_URI,
    {
      description:
        "The picker shown with search_images results: Commons candidates as pictures, chosen with a click.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: IMAGE_PICKER_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: imagePickerHtml,
          _meta: {
            ui: {
              domain: await appDomain(`${config.apiUrl}/mcp`),
              csp: { resourceDomains: IMAGE_HOSTS },
              // The cards carry their own frames; a host border around them
              // would just be a box inside a box.
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );
}
