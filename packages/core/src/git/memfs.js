// An in-memory filesystem for the git engine, for the hosts that have no other.
//
// repo.js and pack.js take `{ fs, gitdir }` precisely so they don't care where
// the objects live: the browser hands them LightningFS over IndexedDB (see
// browser/git/fs.js), and everywhere else hands them this. "Everywhere else" is
// the MCP server (apps/mcp), which forks a lesson and opens a pull request on an
// assistant's behalf — in Node when it runs over stdio, and inside the Cloudflare
// Worker when it runs remotely. Neither has a disk, and the Worker can't have
// one, so the repository is built, used and thrown away in memory.
//
// That fits what a non-browser caller actually does. It never keeps a working
// copy: it clones a lesson's packed history, commits once on top, packs the
// result back up and uploads it. The repository's durable home is R2 (the
// lesson's stored pack), so nothing is lost when this is garbage collected —
// which is why there is no persistence here and no cache to invalidate.
//
// This implements the subset of node:fs's promise API that isomorphic-git binds
// on construction, with POSIX error codes, because isomorphic-git reads `.code`
// to tell "not there" from "broken" (a missing file must be ENOENT, or a first
// commit looks like a failure rather than an empty repo).

/** File mode for a regular file, as git and node:fs report it. */
const FILE_MODE = 0o100644;
/** File mode for a directory. */
const DIR_MODE = 0o40755;
/** File mode for a symbolic link. */
const SYMLINK_MODE = 0o120777;

/** A POSIX-shaped error, so isomorphic-git's `err.code` checks work. */
function fsError(code, path, syscall) {
  const err = new Error(`${code}: ${syscall} '${path}'`);
  err.code = code;
  err.errno = -1;
  err.path = path;
  err.syscall = syscall;
  return err;
}

/**
 * Resolve a path to a canonical absolute one: no empty segments, no "." and no
 * "..". Everything is keyed by the result, so "/a/b", "/a//b" and "/a/./b" are
 * the same node.
 */
function normalize(path) {
  const parts = [];
  for (const part of String(path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirname(path) {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

/** Coerce whatever a caller wrote to bytes. isomorphic-git writes both. */
function toBytes(data) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("Unsupported data passed to writeFile.");
}

/** The encoding out of node:fs's `options`, which may be a bare string. */
function encodingOf(options) {
  if (typeof options === "string") return options;
  return options?.encoding || null;
}

/**
 * A fresh in-memory filesystem, shaped like `node:fs` — pass it straight to any
 * `{ fs, gitdir }` function in repo.js / pack.js.
 *
 * Nothing is shared between calls: each one is its own empty volume, with its
 * own root. Two repositories built in the same process therefore cannot see each
 * other, which is what we want when one request forks a lesson while another is
 * merging one.
 *
 * @returns {{ promises: object }} An fs whose `promises` is an own data property
 *          — isomorphic-git detects the promise API with
 *          `Object.getOwnPropertyDescriptor(fs, 'promises')`, so a getter or an
 *          inherited property would silently drop it back to callback style.
 */
export function memFs() {
  // path -> { type, data?, target?, mode, mtimeMs, ino }
  const nodes = new Map();
  let nextIno = 1;

  const now = () => Date.now();

  function put(path, node) {
    nodes.set(path, { ino: nextIno++, mtimeMs: now(), ...node });
  }

  put("/", { type: "dir", mode: DIR_MODE });

  function lookup(path, syscall) {
    const node = nodes.get(path);
    if (!node) throw fsError("ENOENT", path, syscall);
    return node;
  }

  /** The parent must exist and be a directory before anything can be made in it. */
  function requireParentDir(path, syscall) {
    const parent = nodes.get(dirname(path));
    if (!parent) throw fsError("ENOENT", path, syscall);
    if (parent.type !== "dir") throw fsError("ENOTDIR", path, syscall);
  }

  function statsOf(node) {
    const size = node.type === "file" ? node.data.byteLength : 0;
    return {
      type: node.type === "dir" ? "dir" : "file",
      mode: node.mode,
      size,
      ino: node.ino,
      dev: 1,
      uid: 1,
      gid: 1,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.mtimeMs,
      isFile: () => node.type === "file",
      isDirectory: () => node.type === "dir",
      isSymbolicLink: () => node.type === "symlink",
    };
  }

  const promises = {
    async readFile(path, options) {
      const full = normalize(path);
      const node = lookup(full, "open");
      if (node.type === "dir") throw fsError("EISDIR", full, "read");
      const encoding = encodingOf(options);
      if (encoding) return new TextDecoder().decode(node.data);
      return node.data;
    },

    async writeFile(path, data, options) {
      const full = normalize(path);
      requireParentDir(full, "open");
      const existing = nodes.get(full);
      if (existing && existing.type === "dir") {
        throw fsError("EISDIR", full, "open");
      }
      put(full, {
        type: "file",
        data: toBytes(data),
        mode: options?.mode ?? existing?.mode ?? FILE_MODE,
      });
    },

    async unlink(path) {
      const full = normalize(path);
      const node = lookup(full, "unlink");
      if (node.type === "dir") throw fsError("EISDIR", full, "unlink");
      nodes.delete(full);
    },

    async readdir(path) {
      const full = normalize(path);
      const node = lookup(full, "scandir");
      if (node.type !== "dir") throw fsError("ENOTDIR", full, "scandir");

      // Direct children only: every descendant shares the prefix, so a name with
      // a "/" left in it belongs to a deeper directory.
      const prefix = full === "/" ? "/" : `${full}/`;
      const names = [];
      for (const key of nodes.keys()) {
        if (key === full || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest && !rest.includes("/")) names.push(rest);
      }
      return names.sort();
    },

    async mkdir(path, options) {
      const full = normalize(path);
      if (options?.recursive) {
        // node:fs makes every missing ancestor and treats an existing directory
        // as success, rather than EEXIST.
        let current = "";
        for (const part of full.split("/").filter(Boolean)) {
          current += `/${part}`;
          const existing = nodes.get(current);
          if (existing) {
            if (existing.type !== "dir")
              throw fsError("ENOTDIR", full, "mkdir");
            continue;
          }
          put(current, { type: "dir", mode: DIR_MODE });
        }
        return;
      }
      if (nodes.has(full)) throw fsError("EEXIST", full, "mkdir");
      requireParentDir(full, "mkdir");
      put(full, { type: "dir", mode: DIR_MODE });
    },

    async rmdir(path) {
      const full = normalize(path);
      const node = lookup(full, "rmdir");
      if (node.type !== "dir") throw fsError("ENOTDIR", full, "rmdir");
      const prefix = `${full}/`;
      for (const key of nodes.keys()) {
        if (key.startsWith(prefix)) throw fsError("ENOTEMPTY", full, "rmdir");
      }
      if (full === "/") throw fsError("EBUSY", full, "rmdir");
      nodes.delete(full);
    },

    async stat(path) {
      const full = normalize(path);
      // Resolve the link, which is the whole difference between stat and lstat.
      const node = lookup(full, "stat");
      if (node.type === "symlink") {
        return statsOf(lookup(normalize(node.target), "stat"));
      }
      return statsOf(node);
    },

    async lstat(path) {
      return statsOf(lookup(normalize(path), "lstat"));
    },

    async readlink(path) {
      const full = normalize(path);
      const node = lookup(full, "readlink");
      if (node.type !== "symlink") throw fsError("EINVAL", full, "readlink");
      return node.target;
    },

    async symlink(target, path) {
      const full = normalize(path);
      requireParentDir(full, "symlink");
      if (nodes.has(full)) throw fsError("EEXIST", full, "symlink");
      put(full, {
        type: "symlink",
        target: String(target),
        mode: SYMLINK_MODE,
      });
    },

    async chmod(path, mode) {
      const full = normalize(path);
      const node = lookup(full, "chmod");
      node.mode = mode;
    },
  };

  // A plain own data property, not a getter — see the return doc above.
  return { promises };
}

/**
 * A brand-new empty repository context, ready for `cloneFromPack` or `commitDoc`.
 *
 * The gitdir path is arbitrary (nothing else lives on this volume) but named for
 * what it holds, so a stack trace from isomorphic-git reads sensibly.
 *
 * @returns {{ fs: object, gitdir: string }} The context every function in
 *          repo.js / pack.js takes.
 */
export function memRepo(name = "lesson") {
  return { fs: memFs(), gitdir: `/${name}/.git` };
}
