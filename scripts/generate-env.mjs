// Write a .env the compose stack can actually start with.
//
//   node scripts/generate-env.mjs          # writes .env, refusing to clobber
//   node scripts/generate-env.mjs --force  # overwrites an existing .env
//   node scripts/generate-env.mjs --print  # writes nothing, prints to stdout
//
// This exists because .env.example previously asked the reader to mint two JWTs
// by pasting a `node -e` one-liner out of a comment, and getting that subtly
// wrong is silent: the stack starts, every service looks healthy, and the app
// answers 502 because the value in SERVICE_ROLE_KEY has no dots in it. The
// upstreams do not help — PostgREST calls it a signing error and GoTrue calls it
// a permissions error, and neither says "that is not a token".
//
// The two keys are not decorative. PostgREST reads the `role` claim to decide
// what the caller may do, so:
//
//   ANON_KEY          ships to the browser; public by design.
//   SERVICE_ROLE_KEY  bypasses RLS. Anyone holding it can read and write every
//                     row, including other people's private lesson answers.
//
// They must be signed with the same JWT_SECRET that PostgREST and GoTrue verify
// against, which is exactly why they are generated together, here, rather than
// separately by hand.

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, ".env");
const TEMPLATE = join(ROOT, ".env.example");

// Ten years. These are long-lived service credentials, not sessions — an expiry
// short enough to be a security control would just be an outage waiting to
// happen, and rotating them means regenerating both together anyway.
const TEN_YEARS_SECONDS = 60 * 60 * 24 * 365 * 10;

const base64url = (buffer) => Buffer.from(buffer).toString("base64url");

/** An HS256 JWT carrying `claims`, signed with `secret`. */
function sign(claims, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: "supabase",
      iat: now,
      exp: now + TEN_YEARS_SECONDS,
      ...claims,
    }),
  );
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Values that must not contain URL metacharacters, because they are interpolated
 * into Postgres connection URLs — a password with an @ or a # splits the URL and
 * the service fails with an error about hosts and ports. Hex has no such
 * characters, and is why these are hex rather than base64.
 */
const urlSafeSecret = (bytes = 24) => randomBytes(bytes).toString("hex");

function generate() {
  const jwtSecret = urlSafeSecret(32);
  return {
    POSTGRES_PASSWORD: urlSafeSecret(),
    JWT_SECRET: jwtSecret,
    ANON_KEY: sign({ role: "anon" }, jwtSecret),
    SERVICE_ROLE_KEY: sign({ role: "service_role" }, jwtSecret),
    ADMIN_TOKEN: urlSafeSecret(),
    S3_ACCESS_KEY: urlSafeSecret(12),
    S3_SECRET_KEY: urlSafeSecret(),
  };
}

/**
 * Replace each generated value in the template, leaving everything else — the
 * comments, the URLs, the SMTP block — exactly as it is.
 *
 * Built from .env.example rather than printed from scratch so the result keeps
 * every explanation the example carries, and so a new setting added there is not
 * silently dropped from generated files.
 */
function fill(source, values, { appendMissing = false } = {}) {
  let out = source;
  const unmatched = [];
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (!pattern.test(out)) {
      unmatched.push([key, value]);
      continue;
    }
    out = out.replace(pattern, `${key}=${value}`);
  }
  if (unmatched.length === 0) return out;
  if (!appendMissing) {
    // A rename in .env.example that nobody reflected here would otherwise mean
    // a generated file quietly missing a credential.
    throw new Error(
      `.env.example has no line for: ${unmatched.map(([key]) => key).join(", ")}`,
    );
  }
  // Rewriting an existing .env that predates a new setting: add it rather than
  // refusing, since the alternative is asking someone to hand-merge.
  const added = unmatched.map(([key, value]) => `${key}=${value}`).join("\n");
  return `${out.replace(/\n*$/, "\n")}\n${added}\n`;
}

const args = new Set(process.argv.slice(2));

if (!existsSync(TEMPLATE)) {
  console.error(`Cannot find ${TEMPLATE}`);
  process.exit(1);
}

// Regenerating rewrites the credentials in the .env that is already there,
// rather than starting from the example again. That is the difference between
// "mint me new keys" and "throw away the PUBLIC_URL and SMTP settings I spent
// time getting right", and only the first is ever what somebody means.
const rewriting = existsSync(TARGET) && args.has("--force");
const source = readFileSync(rewriting ? TARGET : TEMPLATE, "utf8");
const filled = fill(source, generate(), { appendMissing: rewriting });

if (args.has("--print")) {
  process.stdout.write(fill(readFileSync(TEMPLATE, "utf8"), generate()));
} else if (existsSync(TARGET) && !args.has("--force")) {
  console.error(
    `${TARGET} already exists. Pass --force to mint new credentials into it, or --print to see a fresh set.`,
  );
  process.exit(1);
} else {
  writeFileSync(TARGET, filled, { mode: 0o600 });
  console.log(`Wrote ${TARGET}`);
  console.log("");
  if (rewriting) {
    console.log(
      "Credentials replaced; everything else in the file was left as it was.",
    );
  } else {
    console.log("Still to fill in by hand:");
    console.log(
      "  PUBLIC_URL / PUBLIC_HOSTNAME  where this instance is reachable from a browser",
    );
    console.log(
      "  SMTP_*                        sign-in is by magic link, so nobody can log in without it",
    );
  }
  console.log("");
  console.log(
    "PUBLIC_URL is baked into the SPA at build time, so set it before `docker compose up -d --build`.",
  );
}
