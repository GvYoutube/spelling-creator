#!/usr/bin/env node
// Local (stdio) entry point for the Spelling Creator MCP server.
//
// This is the `bin` an MCP client (Claude Desktop, Claude Code, Cursor, …)
// spawns. It talks the Model Context Protocol over stdin/stdout, so all human
// output must go to stderr to avoid corrupting the protocol stream.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { applyDotenv, loadConfig } from "./config.js";
import { createAuth } from "./auth.js";
import { createApi } from "./api.js";
import { registerTools, SERVER_INFO } from "./tools.js";
import { LESSON_STANDARDS } from "./standards.js";

const here = dirname(fileURLToPath(import.meta.url));
// Pick up apps/mcp/.env for `pnpm start`; client-supplied env still wins.
applyDotenv(join(here, "..", ".env"));

async function main() {
  const config = loadConfig();
  const auth = createAuth(config);
  const api = createApi(config, auth);

  const server = new McpServer(SERVER_INFO, {
    instructions: LESSON_STANDARDS,
  });
  registerTools(server, { api, config });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stderr is safe to write to (stdout is the protocol channel).
  process.stderr.write(
    `spelling-creator MCP server ready → ${config.apiUrl}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
