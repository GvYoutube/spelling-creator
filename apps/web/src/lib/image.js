// Read a File into raw bytes and measure its natural dimensions so we can size
// it correctly in both the editor preview and the docx/pdf export. The bytes are
// stored as a binary blob (see storeImageBytes); the caller no longer keeps a
// base64 data URL on the block.
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
      img.onload = () => {
        const result = {
          bytes,
          mime,
          width: img.naturalWidth,
          height: img.naturalHeight,
          name: file.name,
        };
        URL.revokeObjectURL(url);
        resolve(result);
      };
      img.src = url;
    };
    reader.readAsArrayBuffer(file);
  });
}

// Selectable image sizes, expressed as a fraction of the available width. The
// editor preview, the docx export and the PDF/preview HTML all scale from these
// same numbers so a picked size looks consistent everywhere. "full" is the
// default and matches the original (un-scaled) behaviour for older lessons.
export const IMAGE_SIZES = [
  { key: "small", label: "Small", scale: 0.4 },
  { key: "medium", label: "Medium", scale: 0.65 },
  { key: "large", label: "Large", scale: 0.85 },
  { key: "full", label: "Full", scale: 1 },
];

export const DEFAULT_IMAGE_SIZE = "full";
export const DEFAULT_IMAGE_ALIGN = "center";

export function imageSizeScale(size) {
  const found = IMAGE_SIZES.find((s) => s.key === size);
  return found ? found.scale : 1; // unknown / missing → full width
}

// Fit an image inside a max width (in px) while preserving aspect ratio.
export function fitWithin(width, height, maxWidth) {
  if (!width || !height) return { width: maxWidth, height: maxWidth };
  if (width <= maxWidth) return { width, height };
  const scale = maxWidth / width;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}
