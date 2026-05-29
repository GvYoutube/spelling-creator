// Read a File into a data URL and measure its natural dimensions so we can
// size it correctly in both the editor preview and the docx/pdf export.
export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image file."));
    reader.onload = () => {
      const dataUrl = reader.result;
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode the image file."));
      img.onload = () => {
        resolve({
          src: dataUrl,
          width: img.naturalWidth,
          height: img.naturalHeight,
          name: file.name,
        });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

// Convert a data URL into the raw bytes docx needs for an ImageRun.
export function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// docx wants one of: png | jpg | gif | bmp
export function imageTypeFromDataUrl(dataUrl) {
  const match = /^data:image\/([a-zA-Z0-9.+-]+)/.exec(dataUrl);
  const raw = match ? match[1].toLowerCase() : "png";
  if (raw === "jpeg") return "jpg";
  if (raw === "svg+xml") return "png"; // svg unsupported by docx ImageRun; fall back
  if (["png", "jpg", "gif", "bmp"].includes(raw)) return raw;
  return "png";
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
