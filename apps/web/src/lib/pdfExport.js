import html2pdf from "html2pdf.js";
import { docToHtml } from "./htmlPreview.js";

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
  // Shared with the preview: builds the docx, converts it to HTML via mammoth
  // and re-applies each image's picked size + alignment, so the PDF mirrors the
  // docx output.
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
