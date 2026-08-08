// Build the distributable .mcpb bundle.
//
// `mcpb pack` zips a folder *as-is*, but this package lives in a pnpm workspace
// whose node_modules are symlinks into a shared store — those don't zip into a
// working bundle. So we stage a clean copy of just the runtime files and vendor
// production dependencies with a flat `npm install --omit=dev` (real files, no
// symlinks), then pack that. Output: dist/spelling-creator-hub.mcpb
//
// The workspace sibling `@spelling-creator/core` needs its own handling. npm has
// never understood the `workspace:` protocol and fails the whole install on it,
// and even if it resolved, a `file:` dependency is symlinked — the exact thing
// that doesn't survive the zip. So the modules the server actually imports are
// copied in as real files and the dependency is taken out of the staged manifest
// before npm ever sees it.
//
// Those modules happen to be dependency-free, which is what makes vendoring them
// cheap: core's full dependency list (yjs, docx, isomorphic-git, supabase…) is
// for its browser modules and has no business in this bundle. That is an
// assumption rather than a guarantee, so it is checked below and the build fails
// loudly if it ever stops holding — better than shipping a bundle that throws
// MODULE_NOT_FOUND on someone's machine.
//
// Run with: pnpm --filter @spelling-creator/mcp pack

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(pkgRoot, "build", "bundle");
const distDir = join(pkgRoot, "dist");
const outFile = join(distDir, "spelling-creator-hub.mcpb");

const WORKSPACE_PROTOCOL = "workspace:";
const CORE_NAME = "@spelling-creator/core";
const coreRoot = join(pkgRoot, "..", "..", "packages", "core");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

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

// Every module specifier a file imports, static or dynamic. Deliberately a regex
// rather than a parser: this only ever reads our own source, where imports are
// plain top-of-file statements.
function importSpecifiers(source) {
  const pattern = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

function jsFilesIn(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

// Walk out from the core subpaths the server imports, following relative imports,
// and report every file reached plus any bare specifier found along the way — a
// bare specifier is a real npm dependency the bundle would need to carry.
function collectCoreModules() {
  const exportsMap = readJson(join(coreRoot, "package.json")).exports || {};

  const subpaths = new Set();
  for (const file of jsFilesIn(join(pkgRoot, "src"))) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (spec === CORE_NAME || spec.startsWith(`${CORE_NAME}/`)) {
        subpaths.add(`.${spec.slice(CORE_NAME.length)}`);
      }
    }
  }

  const queue = [];
  for (const subpath of subpaths) {
    const target = exportsMap[subpath];
    if (!target) {
      throw new Error(
        `${CORE_NAME} has no "${subpath}" export, but the server imports it. ` +
          "Add it to packages/core/package.json's exports map.",
      );
    }
    queue.push(resolve(coreRoot, target));
  }

  const files = new Set();
  const bare = new Map();
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        queue.push(target.endsWith(".js") ? target : `${target}.js`);
      } else if (!spec.startsWith("node:")) {
        bare.set(spec, file);
      }
    }
  }

  if (bare.size) {
    const detail = [...bare]
      .map(([spec, file]) => `  ${spec} (from ${relative(coreRoot, file)})`)
      .join("\n");
    throw new Error(
      `Vendoring ${CORE_NAME} assumes the modules this server imports are dependency-free, ` +
        `but they now reach real packages:\n${detail}\n\n` +
        "Either keep those modules dependency-free, or add the packages above to " +
        "apps/mcp/package.json's dependencies so npm vendors them into the bundle.",
    );
  }

  return { files: [...files], subpaths: [...subpaths], exportsMap };
}

// Copy those modules into the staged node_modules as real files, with a manifest
// carrying just the exports the server uses, so `@spelling-creator/core/richText`
// resolves inside the bundle exactly as it does in the workspace.
function vendorCore({ files, subpaths, exportsMap }) {
  const target = join(staging, "node_modules", CORE_NAME);
  for (const file of files) {
    const dest = join(target, relative(coreRoot, file));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(file, dest);
  }

  const source = readJson(join(coreRoot, "package.json"));
  writeJson(join(target, "package.json"), {
    name: source.name,
    version: source.version,
    license: source.license,
    type: source.type,
    exports: Object.fromEntries(subpaths.map((s) => [s, exportsMap[s]])),
  });

  return files.length;
}

console.log("• Staging a clean copy…");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const entry of INCLUDE) {
  const from = join(pkgRoot, entry);
  if (!existsSync(from)) {
    if (entry === "icon.png") {
      throw new Error("icon.png missing!");
    }
    continue;
  }
  cpSync(from, join(staging, entry), { recursive: true });
}

// Resolve the workspace side before touching npm, so a broken assumption fails
// the build in a second rather than after a full install.
const core = collectCoreModules();

// npm chokes on `workspace:*`, so the staged manifest doesn't carry it — those
// packages are vendored by hand below instead.
const stagedManifest = join(staging, "package.json");
const manifest = readJson(stagedManifest);
const workspaceDeps = Object.entries(manifest.dependencies || {}).filter(
  ([, range]) => range.startsWith(WORKSPACE_PROTOCOL),
);
for (const [name] of workspaceDeps) delete manifest.dependencies[name];
writeJson(stagedManifest, manifest);

console.log("• Vendoring production dependencies (npm install --omit=dev)…");
// --no-package-lock keeps the staging dir tidy; --omit=dev drops the mcpb CLI
// and other dev-only deps so they don't ship in the bundle.
run(
  "npm",
  ["install", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund"],
  staging,
);

// After the install: npm prunes anything it doesn't know about from node_modules.
console.log(`• Vendoring ${CORE_NAME} from the workspace…`);
const vendored = vendorCore(core);
console.log(
  `  ${vendored} module(s): ${core.subpaths.map((s) => s.replace("./", "")).join(", ")}`,
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
