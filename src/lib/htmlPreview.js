import { Packer } from "docx";
import mammoth from "mammoth";
import { buildDocument } from "./docxExport.js";

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

// Build the docx in memory and convert it to HTML with mammoth, so the preview
// matches what the docx/PDF exports produce. Returns an HTML string.
export async function previewHtml(doc) {
  const document = buildDocument(doc);
  const blob = await Packer.toBlob(document);
  const arrayBuffer = await blob.arrayBuffer();
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  return html;
}
