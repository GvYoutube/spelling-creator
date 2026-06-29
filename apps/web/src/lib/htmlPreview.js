import { Packer } from "docx";
import mammoth from "mammoth";
import { buildDocument, DOCX_MAX_IMAGE_WIDTH } from "./docxExport.js";
import { fitWithin, imageSizeScale } from "./image.js";
import { QUESTION_TYPES } from "./questions.js";

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
  .s2c-preview-root figure { margin: 0; }
  .s2c-preview-root img {
    display: block;
    width: 100%;
    height: auto;
  }
`;

// The image blocks of a lesson, in document order — the same order mammoth emits
// their <img> tags, so we can match each tag to its block by position.
function orderedImageBlocks(doc) {
  return doc.sections
    .flatMap((s) => s.blocks)
    .filter((b) => b.type === "image" && (b.image || b.src));
}

// mammoth converts each image to a natural-size <img> in its own <p> and drops the
// block's picked size + alignment (and the caption's alignment). Re-apply both by
// wrapping each image — and its caption, if any — in a fixed-width <figure>:
//
//   - The figure's width is the SAME px size the docx uses (fitWithin against
//     DOCX_MAX_IMAGE_WIDTH × the picked scale), so the image is identical in the
//     preview, the published view and the PDF — not stretched to the container.
//   - max-width:100% lets it shrink on a narrow screen; the image fills the figure.
//   - The figure is aligned via auto side-margins (it's block-level with a set
//     width), and the caption lives inside it, so the caption always tracks the
//     image instead of floating left across the full width.
//
// Caption text comes from the <p> mammoth emits right after the image; buildDocument
// only emits that paragraph when the block has a caption, so we consume the trailing
// paragraph only then and leave following content untouched otherwise.
function layoutImageFigures(html, doc) {
  const imageBlocks = orderedImageBlocks(doc);
  let index = 0;
  return html.replace(
    /<p>\s*(<img\b[^>]*>)\s*<\/p>(\s*<p>([\s\S]*?)<\/p>)?/g,
    (match, imgTag, trailingParagraph, captionInner) => {
      const block = imageBlocks[index++];
      if (!block) return match;

      const scale = imageSizeScale(block.size);
      const { width } = fitWithin(
        block.width,
        block.height,
        DOCX_MAX_IMAGE_WIDTH * scale,
      );
      const align = block.align || "center";
      const figMargin =
        align === "left"
          ? "16px auto 16px 0"
          : align === "right"
            ? "16px 0 16px auto"
            : "16px auto";

      // Strip mammoth's own width/height/style so the figure controls the size.
      const img = imgTag.replace(/\s(?:width|height|style)="[^"]*"/g, "");

      const hasCaption = Boolean(block.caption);
      const caption = hasCaption
        ? `<figcaption style="text-align:center;font-style:italic;color:#555;font-size:12px;margin-top:6px;">${captionInner}</figcaption>`
        : "";
      const figure = `<figure style="display:block;width:${Math.round(
        width,
      )}px;max-width:100%;margin:${figMargin};">${img}${caption}</figure>`;

      // If the block has no caption, the optional trailing paragraph we matched is
      // real content (the next block) — put it back rather than swallowing it.
      return hasCaption ? figure : figure + (trailingParagraph || "");
    },
  );
}

// mammoth discards the run colour we set on each question-type label, so the
// colour coding that survives in the docx is lost in the HTML/PDF path. Each
// label is emitted as `<strong>[Label] …`, so we re-wrap the bracketed label in
// a coloured span to restore it (same idea as re-applying image layout above).
function colorizeQuestionLabels(html) {
  let result = html;
  for (const { label, color } of Object.values(QUESTION_TYPES)) {
    const bracketed = `[${label}]`;
    const escaped = bracketed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(
      new RegExp(`(<strong>)\\s*${escaped}`, "g"),
      `$1<span style="color:${color}">${bracketed}</span>`,
    );
  }
  return result;
}

// Build the docx in memory and convert it to HTML with mammoth, so the preview
// and PDF match what the docx export produces. Returns an HTML string.
export async function docToHtml(doc) {
  const document = await buildDocument(doc);
  const blob = await Packer.toBlob(document);
  const arrayBuffer = await blob.arrayBuffer();
  // mammoth inlines images as base64 data URIs by default; layoutImageFigures then
  // restores each image's picked size + alignment (and its caption's placement).
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  return colorizeQuestionLabels(layoutImageFigures(html, doc));
}

// Back-compat alias used by the preview dialog.
export const previewHtml = docToHtml;
