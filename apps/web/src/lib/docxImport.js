// Best-effort import of a Word .docx back into the lesson model. This is the
// inverse of docxExport.js, and it is deliberately lossy: we run the file
// through mammoth (docx → semantic HTML, the same converter the preview uses),
// then walk that HTML and rebuild the blocks our editor understands.
//
// It is tuned for documents this app produced — the exporter emits a recognised
// shape (a bold title paragraph, `<h2>` section headings, `[Label] …` question
// prompts, a "Spelling words" heading followed by a numbered list). Files
// authored elsewhere import only as well as they happen to match that shape;
// anything we can't recognise degrades to plain text, and a document with no
// section headings at all is rejected (see validateImportedDoc) so we never
// open an unusable lesson in the editor.
import mammoth from "mammoth";
import { newId } from "./id.js";
import { QUESTION_TYPES } from "./questions.js";
import { DEFAULT_IMAGE_SIZE, DEFAULT_IMAGE_ALIGN } from "./image.js";
import { convertDocImages, resolveImageSrc } from "./imageRef.js";

// Thrown when a document is readable but not structured as a lesson. EditorPage
// surfaces the message to the user and refuses to load it (the "refuse to open"
// requirement). Distinct from unexpected errors so callers can tell the two
// apart if they ever want to.
export class DocxImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocxImportError";
  }
}

// Exported question labels (e.g. "Number answer") mapped back to their type key
// (e.g. "number"), keyed lower-case so matching is case-insensitive.
const LABEL_TO_TYPE = Object.fromEntries(
  Object.values(QUESTION_TYPES).map((q) => [q.label.toLowerCase(), q.key]),
);

// Read a .docx File and rebuild a lesson document. Resolves to a doc shaped like
// { title, sections } ready for the editor; rejects (DocxImportError) when the
// file isn't a usable lesson.
export async function importDocxFile(file) {
  if (!file) throw new DocxImportError("No file was selected.");
  if (!/\.docx$/i.test(file.name || "")) {
    throw new DocxImportError(
      "Please choose a Word .docx file. Older .doc files and other formats aren't supported.",
    );
  }

  let html;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    html = result.value || "";
  } catch {
    throw new DocxImportError(
      "This file couldn't be read as a Word document. It may be corrupted or not a real .docx file.",
    );
  }

  if (!html.trim()) {
    throw new DocxImportError("This Word document appears to be empty.");
  }

  const doc = parseHtmlToDoc(html, file.name);
  validateImportedDoc(doc);
  // Measure while the images still carry their base64 `src`, then convert each
  // to a binary blob + hash ref so the imported lesson matches the new model.
  await measureImages(doc);
  return convertDocImages(doc);
}

// Walk mammoth's HTML and rebuild the lesson. We iterate the body's block-level
// children in order; question and spelling blocks greedily consume the metadata
// paragraphs that follow their heading, so the loop index is advanced past them.
function parseHtmlToDoc(html, fileName) {
  const dom = new DOMParser().parseFromString(html, "text/html");
  const nodes = Array.from(dom.body.children);

  // Decide which heading levels act as section dividers. Our own exports use
  // `<h2>`; we also accept `<h3>`, and fall back to `<h1>` for documents that
  // only use top-level headings (with the first one taken as the title).
  const hasTag = (t) => nodes.some((n) => n.tagName.toLowerCase() === t);
  const h1Count = nodes.filter((n) => n.tagName.toLowerCase() === "h1").length;
  const sectionLevels =
    hasTag("h2") || hasTag("h3")
      ? new Set(["h2", "h3"])
      : h1Count >= 2
        ? new Set(["h1"])
        : new Set();

  let title = "";
  const sections = [];
  let current = null;

  const startSection = (name) => {
    current = { id: newId(), name: name || "Untitled section", blocks: [] };
    sections.push(current);
  };
  // Content that appears before the first heading still needs a home.
  const ensureSection = () => {
    if (!current) startSection("Imported section");
    return current;
  };
  const pushText = (text) => {
    const section = ensureSection();
    const last = section.blocks[section.blocks.length - 1];
    if (last && last.type === "text") last.text += `\n${text}`;
    else section.blocks.push({ id: newId(), type: "text", text });
  };

  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];
    const tag = el.tagName.toLowerCase();
    const text = el.textContent.trim();

    // Headings: either a section divider or, failing that, plain text.
    if (tag === "h1") {
      if (!title && current === null && sections.length === 0) {
        title = text;
        continue;
      }
      if (sectionLevels.has("h1")) startSection(text);
      else pushText(text);
      continue;
    }
    if (/^h[2-6]$/.test(tag)) {
      if (sectionLevels.has(tag)) startSection(text);
      else if (text) pushText(text);
      continue;
    }

    // Images (a `<p>` wrapping an `<img>`) — checked before the empty-text skip
    // below, since the wrapping paragraph has no text of its own.
    const img = el.querySelector?.("img");
    if (img?.getAttribute("src")) {
      ensureSection();
      const caption = italicOnlyText(nodes[i + 1]);
      current.blocks.push(imageBlock(img, caption));
      if (caption) i += 1; // consume the caption paragraph
      continue;
    }

    // Real lists (not produced by our exporter, but common elsewhere) — keep the
    // items as text so nothing is silently dropped.
    if (tag === "ul" || tag === "ol") {
      const items = Array.from(el.querySelectorAll("li"))
        .map((li) => li.textContent.trim())
        .filter(Boolean);
      if (items.length) pushText(items.join("\n"));
      continue;
    }

    if (tag !== "p") {
      if (text) pushText(text); // tables etc. → their text
      continue;
    }

    if (!text) continue; // stray empty paragraph

    // A leading bold-only paragraph before any content is the document title
    // (that's how the exporter emits it — Word's Title style, which mammoth
    // renders as a bold paragraph rather than a heading).
    if (
      !title &&
      current === null &&
      sections.length === 0 &&
      isBoldOnly(el) &&
      !matchQuestion(text) &&
      !isSpellingHeading(text)
    ) {
      title = text;
      continue;
    }

    if (isSpellingHeading(text)) {
      ensureSection();
      const { block, next } = readSpelling(nodes, i);
      current.blocks.push(block);
      i = next;
      continue;
    }

    const question = matchQuestion(text);
    if (question) {
      ensureSection();
      const { block, next } = readQuestion(nodes, i, question);
      current.blocks.push(block);
      i = next;
      continue;
    }

    pushText(text);
  }

  return {
    title: title || stripExtension(fileName) || "Imported lesson",
    sections,
  };
}

// True when the paragraph's entire content is a single <strong> (our title and
// question prompts look like this).
function isBoldOnly(el) {
  return el.children.length === 1 && el.children[0].tagName === "STRONG";
}

// The text of a paragraph whose whole content is italic (an image caption in our
// export), or "" if the next node isn't such a paragraph.
function italicOnlyText(el) {
  if (!el || el.tagName !== "P") return "";
  if (el.children.length === 1 && el.children[0].tagName === "EM") {
    return el.textContent.trim();
  }
  return "";
}

function isSpellingHeading(text) {
  return /^spelling words$/i.test(text);
}

// Parse a "[Label] prompt" paragraph into { type, prompt }, or null if the label
// isn't a known question type.
function matchQuestion(text) {
  const m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(text);
  if (!m) return null;
  const type = LABEL_TO_TYPE[m[1].trim().toLowerCase()];
  if (!type) return null;
  return { type, prompt: m[2].trim() };
}

// Build a question block, consuming the metadata paragraphs that follow its
// prompt. Returns { block, next } where `next` is the index of the last node
// consumed (so the caller resumes after it).
function readQuestion(nodes, i, { type, prompt }) {
  const block = { id: newId(), type: "question", questionType: type, prompt };
  const peek = (k) => {
    const el = nodes[k];
    if (!el) return null;
    return { tag: el.tagName.toLowerCase(), text: el.textContent.trim() };
  };
  let last = i;

  if (type === "number") {
    block.answer = "";
    block.steps = [];
    const n = peek(i + 1);
    if (n && n.tag === "p" && /^answer\s*:/i.test(n.text)) {
      block.answer = stripLabel(n.text);
      last = i + 1;
    }
    let k = last + 1;
    const head = peek(k);
    if (head && head.tag === "p" && /^steps\s*:/i.test(head.text)) {
      last = k;
      k += 1;
      let item = peek(k);
      while (item && item.tag === "p" && /^\d+\.\s*/.test(item.text)) {
        const t = item.text.replace(/^\d+\.\s*/, "").trim();
        if (t) block.steps.push({ id: newId(), text: t });
        last = k;
        k += 1;
        item = peek(k);
      }
    }
  } else if (type === "single") {
    block.answer = "";
    const n = peek(i + 1);
    if (n && n.tag === "p" && /^answer\s*:/i.test(n.text)) {
      block.answer = stripLabel(n.text);
      last = i + 1;
    }
  } else if (type === "background") {
    block.answer = "";
    const ans = peek(i + 1);
    if (ans && ans.tag === "p" && /^answer\s*:/i.test(ans.text)) {
      block.answer = stripLabel(ans.text);
      last = i + 1;
    }
  } else if (type === "multiple") {
    block.answers = [];
    let k = i + 1;
    const head = peek(k);
    if (head && head.tag === "p" && /^answers\s*:/i.test(head.text)) {
      last = k;
      k += 1;
      let item = peek(k);
      while (item && item.tag === "p" && /^[•·*-]/.test(item.text)) {
        const t = item.text.replace(/^[•·*-]\s*/, "").trim();
        if (t) block.answers.push({ id: newId(), text: t });
        last = k;
        k += 1;
        item = peek(k);
      }
    }
    if (block.answers.length === 0) {
      block.answers.push({ id: newId(), text: "" });
    }
  }

  return { block, next: last };
}

// Build a spelling block from a "Spelling words" heading followed by numbered
// (or bulleted/list) word paragraphs.
function readSpelling(nodes, i) {
  const block = { id: newId(), type: "spelling", words: [] };
  let last = i;
  let k = i + 1;

  while (k < nodes.length) {
    const el = nodes[k];
    const tag = el.tagName.toLowerCase();
    const text = el.textContent.trim();
    if (tag === "p" && /^\d+\.\s+/.test(text)) {
      const word = text.replace(/^\d+\.\s+/, "").trim();
      if (word) block.words.push({ id: newId(), text: word });
      last = k;
      k += 1;
    } else if (tag === "ol" || tag === "ul") {
      Array.from(el.querySelectorAll("li")).forEach((li) => {
        const word = li.textContent.trim();
        if (word) block.words.push({ id: newId(), text: word });
      });
      last = k;
      break;
    } else if (tag === "p" && /^\(no spelling words/i.test(text)) {
      last = k; // swallow the "(no spelling words yet)" placeholder
      break;
    } else {
      break;
    }
  }

  if (block.words.length === 0) {
    block.words.push({ id: newId(), text: "" });
  }
  return { block, next: last };
}

// Strip a leading "Label: " prefix and treat a blank-line placeholder
// ("____________") as an empty value.
function stripLabel(text) {
  const value = text.replace(/^[^:]*:\s*/, "").trim();
  return /^_+$/.test(value) ? "" : value;
}

function imageBlock(img, caption) {
  return {
    id: newId(),
    type: "image",
    src: img.getAttribute("src"),
    width: 0, // filled in by measureImages()
    height: 0,
    size: DEFAULT_IMAGE_SIZE,
    align: DEFAULT_IMAGE_ALIGN,
    ...(caption ? { caption } : {}),
  };
}

function stripExtension(name) {
  return (name || "").replace(/\.docx$/i, "").trim();
}

// Reject documents that are readable but not structured as a lesson, so the
// editor never opens an unusable import.
function validateImportedDoc(doc) {
  if (!doc.sections.length) {
    throw new DocxImportError(
      "This Word document isn't structured as a lesson. A lesson needs section headings (Word's “Heading 2” style) — the same format you get when you export a lesson from here. Add section headings to the document and try again.",
    );
  }
  const hasContent = doc.sections.some((s) => s.blocks.some(blockHasContent));
  if (!hasContent) {
    throw new DocxImportError(
      "This document has section headings but no readable content beneath them.",
    );
  }
}

function blockHasContent(block) {
  if (block.type === "text") return Boolean(block.text.trim());
  if (block.type === "image") return Boolean(block.image || block.src);
  if (block.type === "question") return Boolean(block.prompt);
  if (block.type === "spelling") {
    return (block.words || []).some((w) => w.text.trim());
  }
  return false;
}

// Imported images carry no dimensions, but the exporter and editor preview need
// them to preserve aspect ratio. Decode each image to read its natural size;
// failures leave it at 0 (the exporter then falls back to a square fit).
async function measureImages(doc) {
  const images = doc.sections
    .flatMap((s) => s.blocks)
    .filter((b) => b.type === "image" && (b.image || b.src));
  await Promise.all(
    images.map(
      (block) =>
        new Promise((resolve) => {
          resolveImageSrc(block)
            .then(({ url, revoke }) => {
              const img = new Image();
              img.onload = () => {
                block.width = img.naturalWidth;
                block.height = img.naturalHeight;
                revoke();
                resolve();
              };
              img.onerror = () => {
                revoke();
                resolve();
              };
              img.src = url;
            })
            .catch(() => resolve());
        }),
    ),
  );
}
