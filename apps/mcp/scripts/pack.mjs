// Build the distributable .mcpb bundle.
//
// `mcpb pack` zips a folder *as-is*, but this package lives in a pnpm workspace
// whose node_modules are symlinks into a shared store — those don't zip into a
// working bundle. So we stage a clean copy of just the runtime files and vendor
// production dependencies with a flat `npm install --omit=dev` (real files, no
// symlinks), then pack that. Output: dist/spelling-creator-hub.mcpb
//
// Run with: pnpm --filter @spelling-creator/mcp pack

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(pkgRoot, "build", "bundle");
const distDir = join(pkgRoot, "dist");
const outFile = join(distDir, "spelling-creator-hub.mcpb");

// Only the files the installed server actually needs at runtime.
const INCLUDE = [
  "manifest.json",
  "package.json",
  "README.md",
  "icon.png",
  "src",
];

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

console.log("• Staging a clean copy…");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const entry of INCLUDE) {
  const from = join(pkgRoot, entry);
  if (!existsSync(from)) {
    if (entry === "icon.png") {
      throw new Error(
        "icon.png missing — run `pnpm --filter @spelling-creator/mcp icon` first.",
      );
    }
    continue;
  }
  cpSync(from, join(staging, entry), { recursive: true });
}

console.log("• Vendoring production dependencies (npm install --omit=dev)…");
// --no-package-lock keeps the staging dir tidy; --omit=dev drops the mcpb CLI
// and other dev-only deps so they don't ship in the bundle.
run(
  "npm",
  ["install", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund"],
  staging,
);

console.log("• Packing the bundle…");
mkdirSync(distDir, { recursive: true });
// Use the workspace-installed mcpb CLI (falls back to a fetched copy via npx).
const mcpbBin = join(pkgRoot, "node_modules", ".bin", "mcpb");
if (existsSync(mcpbBin)) {
  run(mcpbBin, ["pack", staging, outFile], pkgRoot);
} else {
  run(
    "npx",
    ["--yes", "@anthropic-ai/mcpb", "pack", staging, outFile],
    pkgRoot,
  );
}

console.log(`\n✓ Built ${outFile}`);
console.log(
  "  Install it by opening the file with Claude Desktop, or share it as-is.",
);
