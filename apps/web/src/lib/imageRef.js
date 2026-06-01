// Helpers for the new binary image model. An image block references its bytes
// by content hash:  { type:"image", image:{ hash, mime, ext }, width, height }.
// Legacy blocks still carry an inline `src` data URL; every helper here accepts
// both so nothing breaks while existing local/cloud projects are migrated.
//
// Resolution is offline-first: a hash resolves to a local IndexedDB blob when we
// have it, otherwise to the public R2 URL the Worker serves (which exists once
// the lesson has been saved/published).

import { getImageBlob, putImageBlob } from "./imageStore.js";

const API_URL = import.meta.env.VITE_API_URL;

// Public Worker/R2 URL for an uploaded image.
export function imagePublicUrl(hash) {
  const base = (API_URL || "").replace(/\/$/, "");
  return `${base}/images/${hash}`;
}

// docx ImageRun wants one of: png | jpg | gif | bmp. Mirrors the rules the old
// imageTypeFromDataUrl used.
export function extFromMime(mime) {
  const raw = (mime || "").toLowerCase().replace(/^image\//, "");
  if (raw === "jpeg") return "jpg";
  if (raw === "svg+xml") return "png"; // svg unsupported by docx ImageRun
  if (["png", "jpg", "gif", "bmp"].includes(raw)) return raw;
  return "png";
}

// Split a data URL into raw bytes + mime. Handles both base64 (the common case:
// FileReader, the Pixabay proxy, mammoth) and percent-encoded payloads.
export function decodeDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error("Not a data URL.");
  const header = dataUrl.slice(5, comma); // strip the leading "data:"
  const mime = header.split(";")[0] || "image/png";
  const payload = dataUrl.slice(comma + 1);
  let bytes;
  if (/;base64/i.test(header)) {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return { bytes, mime };
}

// Store raw bytes locally and return the persisted image ref to put on a block.
export async function storeImageBytes(bytes, mime) {
  const hash = await putImageBlob(bytes, mime);
  return { hash, mime, ext: extFromMime(mime) };
}

// Resolve an image block to a usable `<img>` src. Returns { url, revoke } where
// revoke() releases an object URL (a no-op for data:/https: URLs).
export async function resolveImageSrc(block) {
  if (block?.src) return { url: block.src, revoke: () => {} };
  const ref = block?.image;
  if (!ref?.hash) return { url: "", revoke: () => {} };
  const blob = await getImageBlob(ref.hash);
  if (blob) {
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  return { url: imagePublicUrl(ref.hash), revoke: () => {} };
}

// Raw bytes for export (docx ImageRun). Legacy → decode the data URL; ref →
// local blob, else fetch from R2. Throws when the bytes can't be obtained so the
// caller can fall back to an "[image could not be embedded]" placeholder.
export async function getImageBytes(block) {
  if (block?.src) {
    const { bytes, mime } = decodeDataUrl(block.src);
    return { bytes, mime, ext: extFromMime(mime) };
  }
  const ref = block?.image;
  if (!ref?.hash) throw new Error("Image block has no source.");
  let blob = await getImageBlob(ref.hash);
  if (!blob) {
    const res = await fetch(imagePublicUrl(ref.hash));
    if (!res.ok) throw new Error("Could not download image bytes.");
    blob = await res.blob();
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = ref.mime || blob.type || "image/png";
  return { bytes, mime, ext: ref.ext || extFromMime(mime) };
}

// Convert any image blocks that still carry an inline `src` data URL into binary
// blobs stored in IndexedDB, replacing `src` with an { image } hash ref. Returns
// the same doc when nothing needed converting, or a new doc otherwise (so React
// state updates only when something actually changed).
export async function convertDocImages(doc) {
  if (!doc || !Array.isArray(doc.sections)) return doc;
  let changed = false;
  const sections = await Promise.all(
    doc.sections.map(async (section) => {
      const blocks = await Promise.all(
        (section.blocks || []).map(async (block) => {
          if (block.type !== "image" || !block.src || block.image) return block;
          try {
            const { bytes, mime } = decodeDataUrl(block.src);
            const image = await storeImageBytes(bytes, mime);
            changed = true;
            // Drop the now-redundant base64 `src`, keep everything else.
            const { src, ...rest } = block;
            void src;
            return { ...rest, image };
          } catch {
            return block; // leave as legacy src — readers still tolerate it
          }
        }),
      );
      return { ...section, blocks };
    }),
  );
  return changed ? { ...doc, sections } : doc;
}
