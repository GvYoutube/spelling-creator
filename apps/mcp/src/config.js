// Configuration resolution for the MCP server.
//
// Everything is driven by environment variables (set directly, or via the
// `env` block of an MCP client's server config — see README). Only an auth
// token is strictly required; the Supabase project and API URL default to the
// public production values, so a fork only needs to override them.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Public production defaults. The anon key is a publishable client key (it ships
// in the web bundle), safe to embed here — it only permits the same anonymous
// auth calls the browser makes, never any data access.
const DEFAULT_API_URL = "https://spellingcreator.org";
const DEFAULT_SUPABASE_URL = "https://hfkgrqihawgosalltjpy.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhma2dycWloYXdnb3NhbGx0anB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNzQ4NDMsImV4cCI6MjA5NTY1MDg0M30.G-Ait5_9WqUfBQLfinHiOPl3w_LwwK5jA_G_aGw97CU";

function trimSlash(value) {
  return (value || "").replace(/\/$/, "");
}

// Where the login helper persists the session and where the server reads it
// back from when no token is given in the environment.
export function sessionFilePath(env = process.env) {
  if (env.SPELLING_CREATOR_SESSION_FILE) {
    return env.SPELLING_CREATOR_SESSION_FILE;
  }
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "spelling-creator-mcp", "session.json");
}

// Best-effort `.env` loader so `pnpm start` / `pnpm login` pick up a local file
// without a dotenv dependency. Existing env vars always win (MCP clients usually
// pass config via their own `env` block). KEY=VALUE per line; # comments and
// optional surrounding quotes are tolerated.
export function applyDotenv(file, env = process.env) {
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return; // No .env file — nothing to do.
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

export function loadConfig(env = process.env) {
  return {
    apiUrl: trimSlash(env.SPELLING_CREATOR_API_URL) || DEFAULT_API_URL,
    supabaseUrl: trimSlash(env.SUPABASE_URL) || DEFAULT_SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
    accessToken: env.SUPABASE_ACCESS_TOKEN || "",
    refreshToken: env.SUPABASE_REFRESH_TOKEN || "",
    sessionFile: sessionFilePath(env),
  };
}
