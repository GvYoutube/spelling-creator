// Best-effort import of a Word .docx back into the lesson model. This is the
// inverse of docxExport.js, and it is deliberately lossy: we run the file
// through mammoth (docx → semantic HTML, the same converter the preview uses),
// then walk that HTML and rebuild the blocks our editor understands.
//
// It is tuned for documents this app produced — the exporter emits a recognised
// shape (a bold title paragraph, question prompts carrying a per-type Word
// character style, a "Spell:" line listing the words). Files authored elsewhere
// import only as well as they happen to match that shape; anything we can't
// recognise degrades to plain text, and a document with no readable content is
// rejected (see validateImportedDoc) so we never open an unusable lesson.
//
// A printed lesson has no section headings and no "[Label]" in front of a
// prompt, so neither is available to read the structure back off. Question types
// come from the character styles instead — questionStyleMap() tells mammoth to
// surface them as `<span class="s2c-q-…">`. Section *divisions* have nothing
// left to carry them, so a document that uses no headings arrives as a single
// section; Export/Import JSON is the lossless round trip.
import mammoth from "mammoth";
import { newId } from "../id.js";
import {
  QUESTION_TYPE_LIST,
  questionStyleClass,
  questionStyleMap,
} from "../questions.js";
import { SPELLING_LABEL } from "../spelling.js";
import { DEFAULT_IMAGE_SIZE, DEFAULT_IMAGE_ALIGN } from "../image.js";
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

// The class mammoth emits for each question style (e.g. "s2c-q-number") mapped
// back to its type key.
const CLASS_TO_TYPE = Object.fromEntries(
  QUESTION_TYPE_LIST.map((q) => [questionStyleClass(q.key), q.key]),
);

// A CSS selector matching a prompt span of any question type.
const QUESTION_SPAN_SELECTOR = QUESTION_TYPE_LIST.map(
  (q) => `span.${questionStyleClass(q.key)}`,
).join(", ");

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
    // The style map is what carries each question's type through the conversion,
    // now that nothing in the visible text names it.
    const result = await mammoth.convertToHtml(
      { arrayBuffer },
      { styleMap: questionStyleMap() },
    );
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
      !matchQuestion(el) &&
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

    const question = matchQuestion(el);
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

// The exporter's spelling line is "Spell: FIRST SECOND THIRD". Older exports
// used a "Spelling words" heading above a numbered list, which readSpelling
// still understands, so both shapes import.
function isSpellingHeading(text) {
  return (
    /^spelling words$/i.test(text) ||
    text.toLowerCase().startsWith(SPELLING_LABEL.toLowerCase())
  );
}

// Read a question off a paragraph whose prompt carries one of our question
// character styles: `<p><span class="s2c-q-single">prompt</span>  answer</p>`.
// Returns { type, prompt, answer } or null when the paragraph isn't one.
function matchQuestion(el) {
  const span = el.querySelector?.(QUESTION_SPAN_SELECTOR);
  if (!span) return null;
  const type = matchQuestionClass(span);
  if (!type) return null;

  // Whatever follows the prompt span in the same paragraph is the answer the
  // exporter wrote in the body colour.
  let answer = "";
  for (let node = span.nextSibling; node; node = node.nextSibling) {
    answer += node.textContent || "";
  }
  return { type, prompt: span.textContent.trim(), answer: answer.trim() };
}

function matchQuestionClass(span) {
  for (const name of span.classList) {
    if (CLASS_TO_TYPE[name]) return CLASS_TO_TYPE[name];
  }
  return null;
}

// Build a question block from its prompt paragraph. The answer travelled inline
// with the prompt; only a number question's working-out spills onto the indented
// paragraphs that follow. Returns { block, next } where `next` is the index of
// the last node consumed (so the caller resumes after it).
function readQuestion(nodes, i, { type, prompt, answer }) {
  const block = { id: newId(), type: "question", questionType: type, prompt };
  let last = i;

  if (type === "number") {
    block.answer = answer;
    block.steps = [];
    // Numbered working-out lines written under the question.
    let k = i + 1;
    for (;;) {
      const el = nodes[k];
      if (!el || el.tagName.toLowerCase() !== "p") break;
      const text = el.textContent.trim();
      if (!/^\d+\.\s*/.test(text)) break;
      const step = text.replace(/^\d+\.\s*/, "").trim();
      if (step) block.steps.push({ id: newId(), text: step });
      last = k;
      k += 1;
    }
  } else if (type === "single" || type === "background") {
    block.answer = answer;
  } else if (type === "multiple") {
    // The exporter joins the accepted answers with a run of spaces, which is the
    // only thing left to split them on. An answer containing a double space
    // would be split in two — a known limit of the lossy DOCX round trip.
    block.answers = answer
      .split(/\s{2,}/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ id: newId(), text }));
    if (block.answers.length === 0) {
      block.answers.push({ id: newId(), text: "" });
    }
  }

  return { block, next: last };
}

// Build a spelling block from either shape: the current "Spell: FIRST SECOND"
// line, or the older "Spelling words" heading followed by numbered (or
// bulleted/list) word paragraphs.
function readSpelling(nodes, i) {
  const block = { id: newId(), type: "spelling", words: [] };
  let last = i;
  let k = i + 1;

  // "Spell: …" carries the words on its own line, separated by runs of spaces.
  // The older "Spelling words" heading has none of its own and falls through to
  // the list-reading loop below.
  const heading = nodes[i].textContent.trim();
  if (heading.toLowerCase().startsWith(SPELLING_LABEL.toLowerCase())) {
    const inline = heading.slice(SPELLING_LABEL.length).trim();
    if (inline && !/^\(no spelling words/i.test(inline)) {
      for (const word of inline.split(/\s{2,}/)) {
        const text = word.trim();
        if (text) block.words.push({ id: newId(), text });
      }
    }
    if (block.words.length === 0) block.words.push({ id: newId(), text: "" });
    return { block, next: last };
  }

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
//
// Section headings are no longer required: an exported lesson has none, so
// demanding them would reject our own documents. What has to be there is
// readable content.
function validateImportedDoc(doc) {
  const hasContent = doc.sections.some((s) => s.blocks.some(blockHasContent));
  if (!hasContent) {
    throw new DocxImportError(
      "This Word document has no readable lesson content — no passages, questions or spelling words could be found in it.",
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
