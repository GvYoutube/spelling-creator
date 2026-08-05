// How a lesson document is laid out inside its git repository.
//
// The whole point of the layout: **every block is its own file, named by its
// block id**.
//
//   lesson.json            { title, ageRange, sections: [{ id, name, blocks: [blockId, ...] }] }
//   blocks/<blockId>.json  the block itself — { id, type, ... }
//
// `lesson.json` is a *manifest*: it holds the structure (which sections exist,
// what they're called, and which blocks they contain, in order) but none of the
// block content. Content lives one-block-per-file under `blocks/`.
//
// This is what makes git's own machinery do the work we want:
//
//   - edit a block   -> exactly one file under blocks/ changes
//   - move a block   -> only lesson.json changes (the block's blob is untouched)
//   - add/remove one -> a file appears/disappears, named by its id
//
// so a plain git tree diff *is* a block-id diff, with no content parsing: two
// blocks are identical exactly when their blob oids are equal, because git
// addresses content by hash. That identity is why diffing (ops.js), merging
// (merge.js) and history (repo.js) can all be expressed as "compare block ids
// and their oids".
//
// Everything here takes `{ fs, gitdir }` rather than reaching for a global, so
// the same code runs against LightningFS in the browser and node:fs in tests.

import * as git from "isomorphic-git";
import { canonicalJson, docBlocks, docManifest } from "./doc.js";

export const MANIFEST_PATH = "lesson.json";
export const BLOCK_DIR = "blocks";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Write a doc into the object store as a tree, and return the tree's oid.
 *
 * Nothing is staged and no working directory is touched — this is pure plumbing
 * (writeBlob -> writeTree). Blocks that didn't change hash to the blob oid they
 * already have, so git stores them once no matter how many commits reference
 * them.
 */
export async function writeDocTree({ fs, gitdir, doc }) {
  const manifestOid = await git.writeBlob({
    fs,
    gitdir,
    blob: encoder.encode(canonicalJson(docManifest(doc))),
  });

  const blockEntries = [];
  for (const [id, block] of docBlocks(doc)) {
    const oid = await git.writeBlob({
      fs,
      gitdir,
      blob: encoder.encode(canonicalJson(block)),
    });
    blockEntries.push({
      mode: "100644",
      path: `${id}.json`,
      oid,
      type: "blob",
    });
  }

  const blocksTreeOid = await git.writeTree({
    fs,
    gitdir,
    tree: blockEntries,
  });

  return git.writeTree({
    fs,
    gitdir,
    tree: [
      { mode: "040000", path: BLOCK_DIR, oid: blocksTreeOid, type: "tree" },
      { mode: "100644", path: MANIFEST_PATH, oid: manifestOid, type: "blob" },
    ],
  });
}

async function readJsonBlob({ fs, gitdir, oid }) {
  const { blob } = await git.readBlob({ fs, gitdir, oid });
  return JSON.parse(decoder.decode(blob));
}

/**
 * The block-id -> blob-oid index of a tree. This is the cheap primitive the
 * diff and history code is built on: comparing two of these maps tells you
 * exactly which blocks were added, removed or changed, without reading a single
 * block's content (oid equality *is* content equality).
 */
export async function readBlockOids({ fs, gitdir, treeOid }) {
  const root = await git.readTree({ fs, gitdir, oid: treeOid });
  const blocksEntry = root.tree.find((entry) => entry.path === BLOCK_DIR);
  const oids = new Map();
  if (!blocksEntry) return oids;

  const blocks = await git.readTree({ fs, gitdir, oid: blocksEntry.oid });
  for (const entry of blocks.tree) {
    if (!entry.path.endsWith(".json")) continue;
    oids.set(entry.path.slice(0, -".json".length), entry.oid);
  }
  return oids;
}

/** The manifest stored in a tree. */
export async function readManifest({ fs, gitdir, treeOid }) {
  const root = await git.readTree({ fs, gitdir, oid: treeOid });
  const entry = root.tree.find((e) => e.path === MANIFEST_PATH);
  if (!entry) return { title: "", ageRange: null, sections: [] };
  return readJsonBlob({ fs, gitdir, oid: entry.oid });
}

/**
 * Rebuild a full editor doc from a tree: read the manifest for structure, then
 * pull each block it names out of blocks/.
 *
 * A block id the manifest lists but blocks/ doesn't hold is skipped rather than
 * throwing — a tree that lost a blob is still worth reading back as much of as
 * we can, and the editor can't render an absent block anyway.
 */
export async function readDocTree({ fs, gitdir, treeOid }) {
  const [manifest, blockOids] = await Promise.all([
    readManifest({ fs, gitdir, treeOid }),
    readBlockOids({ fs, gitdir, treeOid }),
  ]);

  const blocks = new Map();
  for (const [id, oid] of blockOids) {
    blocks.set(id, await readJsonBlob({ fs, gitdir, oid }));
  }

  const doc = {
    title: manifest.title || "",
    sections: (manifest.sections || []).map((section) => ({
      id: section.id,
      name: section.name || "",
      blocks: (section.blocks || [])
        .map((id) => blocks.get(id))
        .filter(Boolean),
    })),
  };
  if (manifest.ageRange) doc.ageRange = manifest.ageRange;
  return doc;
}
