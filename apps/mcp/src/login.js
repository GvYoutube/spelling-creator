#!/usr/bin/env node
// Interactive helper to obtain a Supabase session for the MCP server and persist
// it to the session file, so the server can sign requests (and auto-refresh)
// without a token in its env.
//
// Two ways in:
//   • default: email one-time-code. Sends a code to your email, you paste it back.
//   • --paste : paste the web app's localStorage `sb-<ref>-auth-token` value
//               (the JSON blob); the tokens are extracted from it automatically.
//               Use this if your project's email template doesn't show the code.
//
// Run with:  pnpm --filter @spelling-creator/mcp login

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { applyDotenv, loadConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
applyDotenv(join(here, "..", ".env"));

const config = loadConfig();
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function persist(session) {
  await mkdir(dirname(config.sessionFile), { recursive: true });
  await writeFile(
    config.sessionFile,
    JSON.stringify(
      {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at || null,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`\n✓ Session saved to ${config.sessionFile}`);
  console.log(
    "The MCP server will now sign in automatically (and refresh the token as needed).",
  );
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    apikey: config.supabaseAnonKey,
  };
}

function extractTokens(raw) {
  let text = raw.trim();
  // Supabase may store the value base64-encoded with a `base64-` prefix.
  if (text.startsWith("base64-")) {
    text = Buffer.from(text.slice("base64-".length), "base64").toString("utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "That doesn't look like valid JSON. Paste the whole value.",
    );
  }
  // The value may be the session object itself, or wrapped (e.g. { currentSession }).
  const session =
    parsed.currentSession || parsed.session || parsed.data?.session || parsed;
  const access_token = session.access_token;
  const refresh_token = session.refresh_token;
  if (!access_token || !refresh_token) {
    throw new Error(
      "Couldn't find access_token and refresh_token in the pasted JSON.",
    );
  }
  return { access_token, refresh_token, expires_at: session.expires_at };
}

async function pasteFlow() {
  console.log(
    "\nPaste an existing Supabase session. In the web app, open DevTools →\n" +
      "Application → Local Storage → find the `sb-...-auth-token` entry and copy\n" +
      "its full value (JSON with `access_token` and `refresh_token`).\n",
  );
  const raw = (await rl.question("Paste the value: ")).trim();
  if (!raw) throw new Error("Nothing pasted.");
  await persist(extractTokens(raw));
}

async function otpFlow() {
  const email = (await rl.question("Email: ")).trim();
  if (!email) throw new Error("An email is required.");

  const sendRes = await fetch(`${config.supabaseUrl}/auth/v1/otp`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!sendRes.ok) {
    const detail = await sendRes.text().catch(() => "");
    throw new Error(`Could not send the code (${sendRes.status}). ${detail}`);
  }
  console.log(
    `\nA sign-in code was emailed to ${email}. (If you only see a link and no code,\n` +
      "cancel and re-run with `--paste` instead.)\n",
  );

  const code = (await rl.question("Enter the 6-digit code: ")).trim();
  if (!code) throw new Error("A code is required.");

  const verifyRes = await fetch(`${config.supabaseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ type: "email", email, token: code }),
  });
  if (!verifyRes.ok) {
    const detail = await verifyRes.text().catch(() => "");
    throw new Error(
      `Could not verify the code (${verifyRes.status}). ${detail}\n` +
        "If your email showed a link rather than a code, re-run with `--paste`.",
    );
  }
  const session = await verifyRes.json();
  if (!session.access_token || !session.refresh_token) {
    throw new Error("Verification did not return a session. Try `--paste`.");
  }
  await persist(session);
}

async function main() {
  console.log(`Signing in to ${config.supabaseUrl}\n`);
  if (process.argv.includes("--paste")) {
    await pasteFlow();
  } else {
    await otpFlow();
  }
}

main()
  .catch((err) => {
    console.error(`\n✗ ${err.message || err}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
