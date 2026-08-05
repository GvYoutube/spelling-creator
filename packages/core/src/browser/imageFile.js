// Mirrors the server's CONVERTIBLE set (apps/api/src/imageConvert.js): only
// formats we can safely flatten to a static raster get re-encoded. gif (often
// animated), svg (vector) and already-webp pass through untouched.
const CONVERTIBLE_TO_WEBP = new Set(["image/png", "image/jpeg", "image/jpg"]);

// Same quality the server targets, on canvas's 0–1 scale (server uses 0–100).
const WEBP_QUALITY = 0.8;

// Re-encode a decoded <img> to WEBP on a canvas. Returns null if the browser's
// canvas can't encode WEBP (toBlob silently falls back to PNG in that case),
// the encode fails, or the result isn't actually smaller than the original —
// mirroring the server's keep-whichever-is-smaller rule.
async function tryEncodeWebp(img, width, height, originalSize) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/webp", WEBP_QUALITY),
  );
  if (!blob || blob.type !== "image/webp" || blob.size >= originalSize) {
    return null;
  }
  return new Uint8Array(await blob.arrayBuffer());
}

// Read a File into raw bytes and measure its natural dimensions so we can size
// it correctly in both the editor preview and the docx/pdf export. The bytes are
// stored as a binary blob (see storeImageBytes); the caller no longer keeps a
// base64 data URL on the block.
//
// PNG/JPEG uploads are opportunistically re-encoded to WEBP client-side to save
// upload bandwidth and storage. This is a best-effort optimization, not a
// guarantee: the server (apps/api/src/imageConvert.js) re-validates the
// content type and performs the same conversion as a fallback for anything
// that reaches it as a non-WEBP raster (unsupported browser, modified client,
// etc.), so correctness never depends on this step succeeding.
export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image file."));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      const mime = file.type || "image/png";
      // Measure via a temporary object URL — cheaper than a base64 data URL and
      // revoked as soon as we have the dimensions.
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const img = new Image();
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not decode the image file."));
      };
      img.onload = async () => {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        let outBytes = bytes;
        let outMime = mime;
        if (CONVERTIBLE_TO_WEBP.has(mime.toLowerCase())) {
          try {
            const webpBytes = await tryEncodeWebp(
              img,
              width,
              height,
              bytes.length,
            );
            if (webpBytes) {
              outBytes = webpBytes;
              outMime = "image/webp";
            }
          } catch {
            // Keep the original bytes/mime — the server converts as a fallback.
          }
        }
        URL.revokeObjectURL(url);
        resolve({
          bytes: outBytes,
          mime: outMime,
          width,
          height,
          name: file.name,
        });
      };
      img.src = url;
    };
    reader.readAsArrayBuffer(file);
  });
}
