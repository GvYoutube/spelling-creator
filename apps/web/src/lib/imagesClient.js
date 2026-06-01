// Uploads a lesson's images to the Worker (R2-backed) before the lesson doc is
// saved to the cloud. Images live only in IndexedDB while a lesson is drafted
// offline; this is what copies them to the cloud so other viewers (and the
// server-side og-image/prerender) can load them by hash.

import { getImageBlob } from "./imageStore.js";
import { imagePublicUrl } from "./imageRef.js";

const API_URL = import.meta.env.VITE_API_URL;

// Hashes already confirmed present in R2 this session (uploaded, or known to be
// cloud-sourced). Lets repeated saves of the same lesson skip re-PUTting every
// image — keeping R2 write (class-A) operations ≈ the number of distinct images,
// not number of saves.
const known = new Set();

// Every distinct image hash referenced by the doc. Legacy `src` blocks must be
// converted to refs (convertDocImages) before calling this.
export function collectImageHashes(doc) {
  const hashes = new Set();
  for (const section of doc?.sections || []) {
    for (const block of section.blocks || []) {
      if (block.type === "image" && block.image?.hash) {
        hashes.add(block.image.hash);
      }
    }
  }
  return [...hashes];
}

// PUT one blob to R2. The endpoint is content-addressed and idempotent, so a
// re-upload of identical bytes is harmless.
async function uploadImage(hash, blob, accessToken) {
  let res;
  try {
    res = await fetch(imagePublicUrl(hash), {
      method: "PUT",
      headers: {
        "Content-Type": blob.type || "application/octet-stream",
        Authorization: `Bearer ${accessToken}`,
      },
      body: blob,
    });
  } catch {
    throw new Error("Could not reach the image store.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Image upload failed (${res.status}).`);
  }
}

// Ensure every image referenced by the doc exists in R2, uploading any blob that
// is currently only local. Throws on the first failure so the caller aborts the
// save before writing a doc row that would reference a missing object.
export async function ensureImagesUploaded(doc, accessToken) {
  if (!API_URL) throw new Error("The image store is not configured.");
  if (!accessToken) throw new Error("Please sign in before saving.");
  for (const hash of collectImageHashes(doc)) {
    if (known.has(hash)) continue;
    const blob = await getImageBlob(hash);
    // No local blob means the image came from the cloud already (an existing
    // lesson's image) — it's in R2, nothing to upload.
    if (!blob) {
      known.add(hash);
      continue;
    }
    await uploadImage(hash, blob, accessToken);
    known.add(hash);
  }
}
