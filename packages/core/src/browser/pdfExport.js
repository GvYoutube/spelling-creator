// Print a lesson to PDF by way of the Word document: build the docx, convert it
// to HTML with mammoth, then render that HTML with html2pdf.js. Going through
// the docx is what makes the PDF match the exported .docx page for page.
//
// This is the only path in the app that does so. The editor's preview dialog and
// the public lesson page both render the lesson model directly (LessonView), so
// `docx` + `mammoth` are reachable only from Export, Save to Drive and this
// file — never from simply looking at a lesson.
import html2pdf from "html2pdf.js";
import mammoth from "mammoth";
import { Packer } from "docx";
import { buildDocument } from "./docxExport.js";
import { fitWithin, imageSizeScale } from "../image.js";
import { DOCX_MAX_IMAGE_WIDTH } from "../lessonLayout.js";
import { QUESTION_TYPES } from "../questions.js";

// Text destined for an HTML string we build ourselves. The PDF container is
// filled with innerHTML, so anything interpolated into it has to arrive as text.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
//     PDF and the published view — not stretched to the container.
//   - max-width:100% lets it shrink on a narrow page; the image fills the figure.
//   - The figure is aligned via auto side-margins (it's block-level with a set
//     width), and the caption lives inside it, so the caption always tracks the
//     image instead of floating left across the full width.
//
// The caption is taken from the block itself and escaped, NOT copied out of
// mammoth's HTML: the text is ours either way, and reading it from the model
// means nothing that came back through the converter is re-inserted as markup.
// buildDocument only emits a caption paragraph when the block has a caption, so
// the trailing paragraph is consumed only then and following content is left
// untouched otherwise.
function layoutImageFigures(html, doc) {
  const imageBlocks = orderedImageBlocks(doc);
  let index = 0;
  return html.replace(
    /<p>\s*(<img\b[^>]*>)\s*<\/p>(\s*<p>[\s\S]*?<\/p>)?/g,
    (match, imgTag, trailingParagraph) => {
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
        ? `<figcaption style="text-align:center;font-style:italic;color:#555;font-size:12px;margin-top:6px;">${escapeHtml(
            block.caption,
          )}</figcaption>`
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

// Build the docx in memory and convert it to HTML with mammoth, so the PDF
// matches what the docx export produces. Returns an HTML string.
async function docToHtml(doc) {
  const document = await buildDocument(doc);
  const blob = await Packer.toBlob(document);
  const arrayBuffer = await blob.arrayBuffer();
  // mammoth inlines images as base64 data URIs by default; layoutImageFigures then
  // restores each image's picked size + alignment (and its caption's placement).
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  return colorizeQuestionLabels(layoutImageFigures(html, doc));
}

// Print styles applied to the mammoth-generated HTML before rendering to PDF.
const PRINT_STYLES = `
  .s2c-pdf-root {
    font-family: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.5;
    font-size: 14px;
  }
  .s2c-pdf-root h1 {
    text-align: center;
    font-size: 26px;
    margin: 0 0 24px;
    color: #1a1a1a;
  }
  .s2c-pdf-root h2 {
    font-size: 19px;
    color: #3b5bdb;
    border-bottom: 2px solid #3b5bdb;
    padding-bottom: 4px;
    margin: 22px 0 12px;
  }
  .s2c-pdf-root p { margin: 0 0 10px; }
  .s2c-pdf-root figure { margin: 0; }
  .s2c-pdf-root img {
    display: block;
    width: 100%;
    height: auto;
  }
`;

function safeFileName(title) {
  const base = (title || "lesson")
    .trim()
    .replace(/[^a-z0-9\-_ ]/gi, "")
    .replace(/\s+/g, "-");
  return `${base || "lesson"}.pdf`;
}

// Build the docx, convert to HTML (mammoth), then render to a PDF (html2pdf.js).
export async function exportPdf(doc) {
  // docToHtml builds the docx, converts it to HTML via mammoth and re-applies
  // each image's picked size + alignment, so the PDF mirrors the docx output.
  const html = await docToHtml(doc);

  const container = window.document.createElement("div");
  container.className = "s2c-pdf-root";
  container.innerHTML = `<style>${PRINT_STYLES}</style>${html}`;
  // Size the content box to the printable width html2pdf renders into:
  // pageSize.inner.width = the A4-in-px page (794px) minus the 38px L/R page
  // margins set below = 718px. `border-box` keeps the padding *inside* that
  // width instead of adding to it, otherwise the box (718 + 2×40 = 798px)
  // overflows html2pdf's 718px container, gets clipped on the right by the
  // overlay's `overflow: hidden`, and every line is cut off / shifted right.
  container.style.boxSizing = "border-box";
  container.style.width = "718px";
  container.style.padding = "40px";
  container.style.background = "#ffffff";

  // html2pdf renders by cloning the element we pass to `.from()` (cloneNode
  // copies inline styles) and re-hosting that clone inside its own on-screen,
  // opacity:0 overlay container. So the off-screen positioning has to live on
  // a *wrapper*, never on `container` itself. If `container` carried
  // `position: absolute; left: -10000px`, the clone would inherit it, drop out
  // of flow inside html2pdf's container (collapsing it to ~0 height) and shift
  // off-screen, so html2canvas would capture an empty box → a blank PDF.
  const offscreen = window.document.createElement("div");
  offscreen.style.position = "absolute";
  offscreen.style.left = "-10000px";
  offscreen.style.top = "0";
  offscreen.appendChild(container);
  window.document.body.appendChild(offscreen);

  try {
    await html2pdf()
      .set({
        // Pixel units (not mm) on purpose. html2pdf places page breaks using a
        // page height it derives by rounding mm→px (floor(277mm) = 1046px), but
        // it slices the rendered canvas at a *separately* computed height
        // (floor(canvas.width × inner ratio) = 1046.5px). That ½px-per-page
        // mismatch makes the top sliver of each page's first line bleed onto the
        // bottom of the previous page — text cut off at the page edge — and it
        // grows with page count. Driving jsPDF in px with an integer A4 format
        // (794×1123px @96dpi) and integer 38px (~10mm) margins makes both
        // computations use the identical integer inner height (1047px), so the
        // break positions and the slice positions line up exactly.
        margin: [38, 38, 38, 38],
        filename: safeFileName(doc.title),
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "px", format: [794, 1123], orientation: "portrait" },
        pagebreak: { mode: ["avoid-all", "css", "legacy"] },
      })
      .from(container)
      .save();
  } finally {
    window.document.body.removeChild(offscreen);
  }
}
