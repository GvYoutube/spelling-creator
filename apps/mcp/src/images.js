// Small image helpers shared by the API client (api.js, which uploads bytes) and
// the doc builder (doc.js, which validates image-block refs). Kept dependency-free
// and using Web Crypto so they work on both transports (Node ≥18 and the Worker).
//
// An image block references its bytes by content hash, exactly like the web app
// (see apps/web/src/lib/imageRef.js):  image: { hash, mime, ext }. The hash is the
// lowercase-hex SHA-256 of the raw bytes, which is also the R2 object key the
// Worker stores them under and recomputes on upload (PUT /images/:hash).

// Lowercase hex SHA-256 of the given bytes — the content address used as the R2
// object key, so a hash computed here matches the one the Worker recomputes.
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Normalise a mime type to the short extension the editor stores on the block.
// Mirrors apps/web/src/lib/imageRef.js extFromMime so blocks built here match the
// web app's shape (svg is unsupported by the docx export, so it maps to png).
export function extFromMime(mime) {
  const raw = (mime || "").toLowerCase().replace(/^image\//, "");
  if (raw === "jpeg") return "jpg";
  if (raw === "svg+xml") return "png";
  if (["png", "jpg", "gif", "bmp", "webp"].includes(raw)) return raw;
  return "png";
}
