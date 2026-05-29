import { Packer } from "docx";
import mammoth from "mammoth";
import { buildDocument } from "./docxExport.js";
import { imageSizeScale } from "./image.js";

// Styles applied to the mammoth-generated HTML shown in the preview dialog.
// Mirrors the docx/PDF look so the preview reflects the final document.
export const PREVIEW_STYLES = `
  .s2c-preview-root {
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.5;
    font-size: 14px;
  }
  .s2c-preview-root h1 {
    text-align: center;
    font-size: 26px;
    margin: 0 0 24px;
    color: #1a1a1a;
  }
  .s2c-preview-root h2 {
    font-size: 19px;
    color: #3b5bdb;
    border-bottom: 2px solid #3b5bdb;
    padding-bottom: 4px;
    margin: 22px 0 12px;
  }
  .s2c-preview-root p { margin: 0 0 10px; }
  .s2c-preview-root img {
    display: block;
    max-width: 100%;
    margin: 12px auto;
    height: auto;
  }
`;

// Inline style for one image in the converted HTML, derived from the block's
// picked size + alignment. Since the image is display:block, the side margins
// decide its horizontal alignment.
function imageStyle(block) {
  const scale = imageSizeScale(block?.size);
  const align = block?.align || "center";
  const margin =
    align === "left"
      ? "12px auto 12px 0"
      : align === "right"
        ? "12px 0 12px auto"
        : "12px auto";
  return `display:block;height:auto;max-width:${Math.round(
    scale * 100,
  )}%;margin:${margin};`;
}

// mammoth drops image size and alignment when it converts the docx to HTML, so
// we re-apply them here. Images are emitted in the same order as the image
// blocks in the lesson, so we walk that ordered list as each image is converted.
function imageLayoutOptions(doc) {
  const imageBlocks = doc.sections
    .flatMap((s) => s.blocks)
    .filter((b) => b.type === "image" && b.src);
  let index = 0;
  return {
    convertImage: mammoth.images.imgElement((image) =>
      image.read("base64").then((data) => {
        const block = imageBlocks[index++];
        return {
          src: `data:${image.contentType};base64,${data}`,
          style: imageStyle(block),
        };
      }),
    ),
  };
}

// Build the docx in memory and convert it to HTML with mammoth, so the preview
// and PDF match what the docx export produces. Returns an HTML string.
export async function docToHtml(doc) {
  const document = buildDocument(doc);
  const blob = await Packer.toBlob(document);
  const arrayBuffer = await blob.arrayBuffer();
  const { value: html } = await mammoth.convertToHtml(
    { arrayBuffer },
    imageLayoutOptions(doc),
  );
  return html;
}

// Back-compat alias used by the preview dialog.
export const previewHtml = docToHtml;
