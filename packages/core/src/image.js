// Image sizing — the numbers the editor preview, the docx export and the
// PDF/preview HTML all scale from, so a picked size looks consistent everywhere.
//
// Pure arithmetic, deliberately kept out of the browser tier: the import/export
// paths and the lesson-file parser need these constants, and none of them should
// have to pull in a module that touches a <canvas>. Reading a File and encoding
// it lives in ./browser/imageFile.js instead.

// Selectable image sizes, expressed as a fraction of the available width.
// "full" is the default and matches the original (un-scaled) behaviour for
// older lessons.
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
