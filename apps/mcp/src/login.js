#!/usr/bin/env node
// Interactive helper to obtain a Supabase session for the MCP server and persist
// it to the session file, so the server can sign requests (and auto-refresh)
// without a token in its env.
//
// Two ways in:
//   • default: email one-time-code. Sends a code to your email, you paste it back.
//   • --paste : paste an access_token + refresh_token you already have (e.g.
//               copied from the web app's localStorage `sb-<ref>-auth-token`).
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

async function pasteFlow() {
  console.log(
    "\nPaste an existing Supabase session. In the web app, open DevTools →\n" +
      "Application → Local Storage → find the `sb-...-auth-token` entry; it's JSON\n" +
      "with `access_token` and `refresh_token`.\n",
  );
  const access_token = (await rl.question("access_token: ")).trim();
  const refresh_token = (await rl.question("refresh_token: ")).trim();
  if (!access_token || !refresh_token) {
    throw new Error("Both tokens are required.");
  }
  await persist({ access_token, refresh_token });
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
