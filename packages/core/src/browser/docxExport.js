// Build a printed lesson as a Word document.
//
// The layout is the one a finished lesson is published in: a centred title
// block, then the lesson's blocks running straight down the page with no section
// headings, and a footer on every page carrying the copyright line above the
// question-type legend. A question prints as its prompt in the colour of its
// type followed, in black, by its answer — the colour is the only thing marking
// the type, so nothing is bracketed or labelled in the text.
//
// pdfExport.js converts this document to HTML with mammoth and renders that, so
// the PDF matches page for page; docxImport.js reads the same shape back.
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
  AlignmentType,
  Header,
  Footer,
  PageNumber,
} from "docx";
import { fitWithin, imageSizeScale } from "../image.js";
import { getImageBytes } from "./imageRef.js";
import {
  DOCX_MAX_IMAGE_WIDTH,
  LEGEND_SEPARATOR,
  QUESTION_LINE_STYLE_ID,
  QUESTION_LINE_STYLE_NAME,
  TITLE_LINE_STYLE_ID,
  TITLE_LINE_STYLE_NAME,
  lessonCopyright,
  lessonTitleLines,
} from "../lessonLayout.js";
import {
  ANSWER_GAP,
  QUESTION_LEGEND,
  QUESTION_TYPE_LIST,
  questionAnswerText,
  questionMeta,
  questionStyleId,
  questionStyleName,
} from "../questions.js";
import {
  SPELLING_COLOR,
  SPELLING_LABEL,
  SPELLING_WORD_SEPARATOR,
} from "../spelling.js";

// Re-exported for callers that already reach for it here. New code that wants
// only the constant should import ../lessonLayout.js directly — this module
// pulls in the whole `docx` library.
export { DOCX_MAX_IMAGE_WIDTH };

// Body text size, in docx half-points (28 = 14pt).
const BODY_SIZE = 28;

const ALIGNMENT_MAP = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
};

function imageAlignment(block) {
  return ALIGNMENT_MAP[block.align] || AlignmentType.CENTER;
}

// `docx` wants colours as bare hex, without the leading '#'.
function hex(color) {
  return color.replace("#", "");
}

function textBlockParagraphs(block) {
  const lines = (block.text || "").split("\n");
  return lines.map(
    (line) =>
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: line, size: BODY_SIZE })],
      }),
  );
}

async function imageBlockParagraphs(block) {
  const paragraphs = [];
  const alignment = imageAlignment(block);
  try {
    const { bytes, ext } = await getImageBytes(block);
    const { width, height } = fitWithin(
      block.width,
      block.height,
      DOCX_MAX_IMAGE_WIDTH * imageSizeScale(block.size),
    );
    paragraphs.push(
      new Paragraph({
        alignment,
        spacing: { before: 120, after: 60 },
        children: [
          new ImageRun({
            type: ext,
            data: bytes,
            transformation: { width, height },
          }),
        ],
      }),
    );
  } catch {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({ text: "[image could not be embedded]", italics: true }),
        ],
      }),
    );
  }
  if (block.caption) {
    paragraphs.push(
      new Paragraph({
        alignment,
        spacing: { after: 160 },
        children: [
          new TextRun({
            text: block.caption,
            italics: true,
            size: 22,
            color: "555555",
          }),
        ],
      }),
    );
  }
  return paragraphs;
}

// One question: the prompt in its type's colour, then the answer in black on the
// same line. Consecutive questions sit directly under one another, so the run of
// them reads as a block of colour-coded lines rather than a list of headings.
function questionBlockParagraphs(block) {
  const meta = questionMeta(block.questionType);
  const answer = questionAnswerText(block);
  const steps = (block.steps || [])
    .map((s) => (s.text || "").trim())
    .filter(Boolean);

  const children = [
    // The named character style is what carries the type through mammoth to the
    // PDF and the importer; the explicit colour is what Word itself renders.
    new TextRun({
      text: block.prompt || "(no question text)",
      style: questionStyleId(meta.key),
      color: hex(meta.color),
      size: BODY_SIZE,
    }),
  ];
  if (answer) {
    children.push(
      new TextRun({
        text: `${ANSWER_GAP}${answer}`,
        size: BODY_SIZE,
        color: "000000",
      }),
    );
  }

  const paragraphs = [
    new Paragraph({
      style: QUESTION_LINE_STYLE_ID,
      spacing: { after: steps.length ? 40 : 20 },
      children,
    }),
  ];

  // Working-out for a number question, when the author recorded any. The scanned
  // layout has no separate steps line, so these stay indented and out of the way
  // of the question run above.
  steps.forEach((text, i) => {
    paragraphs.push(
      new Paragraph({
        spacing: { after: i === steps.length - 1 ? 60 : 40 },
        indent: { left: 360 },
        children: [new TextRun({ text: `${i + 1}. ${text}`, size: 24 })],
      }),
    );
  });

  return paragraphs;
}

// The spelling words as one running line: "Spell: FIRST SECOND THIRD".
function spellingBlockParagraphs(block) {
  const words = (block.words || [])
    .map((w) => (w.text || "").trim())
    .filter(Boolean);

  return [
    new Paragraph({
      spacing: { before: 160, after: 60 },
      children: [
        new TextRun({
          text: `${SPELLING_LABEL} `,
          bold: true,
          color: hex(SPELLING_COLOR),
          size: BODY_SIZE,
        }),
        new TextRun({
          text: words.length
            ? words.join(SPELLING_WORD_SEPARATOR)
            : "(no spelling words yet)",
          italics: words.length === 0,
          size: BODY_SIZE,
        }),
      ],
    }),
  ];
}

// A section's blocks, with no heading of its own. Section names are an
// organising device inside the editor; a printed lesson runs straight through.
async function sectionParagraphs(section) {
  const paragraphs = [];
  for (const block of section.blocks) {
    if (block.type === "text") {
      paragraphs.push(...textBlockParagraphs(block));
    } else if (block.type === "image" && (block.image || block.src)) {
      paragraphs.push(...(await imageBlockParagraphs(block)));
    } else if (block.type === "question") {
      paragraphs.push(...questionBlockParagraphs(block));
    } else if (block.type === "spelling") {
      paragraphs.push(...spellingBlockParagraphs(block));
    }
  }
  return paragraphs;
}

// Title, by-line and the age/release lines, all centred.
function titleParagraphs(doc, meta) {
  const lines = lessonTitleLines(doc, meta);
  const paragraphs = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: lines.length ? 60 : 240 },
      children: [
        new TextRun({ text: doc.title || "Untitled Lesson", bold: true }),
      ],
    }),
  ];
  lines.forEach((line, i) => {
    paragraphs.push(
      new Paragraph({
        style: TITLE_LINE_STYLE_ID,
        alignment: AlignmentType.CENTER,
        spacing: { after: i === lines.length - 1 ? 240 : 40 },
        children: [
          new TextRun({ text: line.text, bold: line.bold, size: BODY_SIZE }),
        ],
      }),
    );
  });
  return paragraphs;
}

// The page footer: the copyright line, then the legend naming every question
// type in its own colour. The legend is what makes the colour coding above it
// readable, so it repeats on every page.
function pageFooter(meta) {
  const children = [];

  const copyright = lessonCopyright(meta);
  if (copyright) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 20 },
        children: [new TextRun({ text: copyright, bold: true, size: 18 })],
      }),
    );
  }

  const legend = [];
  QUESTION_LEGEND.forEach((type, i) => {
    if (i > 0) {
      legend.push(
        new TextRun({ text: LEGEND_SEPARATOR, size: 16, color: "555555" }),
      );
    }
    legend.push(
      new TextRun({
        text: type.label.toUpperCase(),
        size: 16,
        color: hex(type.color),
      }),
    );
  });
  children.push(
    new Paragraph({ alignment: AlignmentType.CENTER, children: legend }),
  );

  return new Footer({ children });
}

// The page number, top right, as the scanned lessons carry it.
function pageHeader() {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ children: [PageNumber.CURRENT], size: 20 })],
      }),
    ],
  });
}

// One Word character style per question type, so the type survives the round
// trip through mammoth (see questions.js for why this exists).
function questionCharacterStyles() {
  return QUESTION_TYPE_LIST.map((type) => ({
    id: questionStyleId(type.key),
    name: questionStyleName(type.key),
    basedOn: "DefaultParagraphFont",
    quickFormat: false,
    run: { color: hex(type.color) },
  }));
}

/**
 * Build an in-memory docx Document from the lesson state. Async because image
 * bytes may need fetching from R2 for a lesson whose images aren't held locally.
 *
 * @param {object} doc   the lesson document ({ title, ageRange, sections })
 * @param {{author?: string, published?: string|number|Date}} [meta]
 *   who the lesson is by and when it was published — used for the by-line and
 *   the footer's copyright line. Both lines are omitted when not supplied.
 */
export async function buildDocument(doc, meta = {}) {
  const children = titleParagraphs(doc, meta);

  for (const section of doc.sections) {
    children.push(...(await sectionParagraphs(section)));
  }

  return new Document({
    creator: meta.author || "Spelling Lesson Maker",
    title: doc.title || "Untitled Lesson",
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: BODY_SIZE },
        },
      },
      paragraphStyles: [
        {
          id: TITLE_LINE_STYLE_ID,
          name: TITLE_LINE_STYLE_NAME,
          basedOn: "Normal",
          quickFormat: false,
          paragraph: { alignment: AlignmentType.CENTER },
        },
        {
          id: QUESTION_LINE_STYLE_ID,
          name: QUESTION_LINE_STYLE_NAME,
          basedOn: "Normal",
          quickFormat: false,
        },
      ],
      characterStyles: questionCharacterStyles(),
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 },
          },
        },
        headers: { default: pageHeader() },
        footers: { default: pageFooter(meta) },
        children,
      },
    ],
  });
}

function safeFileName(title) {
  const base = (title || "lesson")
    .trim()
    .replace(/[^a-z0-9\-_ ]/gi, "")
    .replace(/\s+/g, "-");
  return `${base || "lesson"}.docx`;
}

/**
 * Generate and download the .docx file.
 * @param {object} doc
 * @param {{author?: string, published?: string|number|Date}} [meta]
 */
export async function exportDocx(doc, meta = {}) {
  const document = await buildDocument(doc, meta);
  const blob = await Packer.toBlob(document);
  triggerDownload(blob, safeFileName(doc.title));
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
