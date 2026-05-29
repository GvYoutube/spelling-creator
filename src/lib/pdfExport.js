import { Packer } from "docx";
import mammoth from "mammoth";
import html2pdf from "html2pdf.js";
import { buildDocument } from "./docxExport.js";

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
  .s2c-pdf-root img {
    display: block;
    max-width: 100%;
    margin: 12px auto;
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
  const document = buildDocument(doc);
  const blob = await Packer.toBlob(document);
  const arrayBuffer = await blob.arrayBuffer();

  // mammoth converts the docx into clean semantic HTML and inlines images as
  // base64 data URIs by default, so the PDF mirrors the docx output.
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });

  const container = window.document.createElement("div");
  container.className = "s2c-pdf-root";
  container.innerHTML = `<style>${PRINT_STYLES}</style>${html}`;
  container.style.width = "794px"; // ~A4 width at 96dpi
  container.style.padding = "40px";
  container.style.background = "#ffffff";

  // html2pdf renders by cloning the element we pass to `.from()` (cloneNode
  // copies inline styles) and re-hosting that clone inside its own on-screen,
  // opacity:0 overlay container. So the off-screen positioning has to live on
  // a *wrapper* — never on `container` itself. If `container` carried
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
        margin: [10, 10, 10, 10],
        filename: safeFileName(doc.title),
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["avoid-all", "css", "legacy"] },
      })
      .from(container)
      .save();
  } finally {
    window.document.body.removeChild(offscreen);
  }
}
