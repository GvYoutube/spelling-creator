import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
} from "docx";
import {
  dataUrlToUint8Array,
  imageTypeFromDataUrl,
  fitWithin,
} from "./image.js";
import { questionMeta } from "./questions.js";

// Max image width inside the docx page (in px; docx maps px→EMU internally).
const DOCX_MAX_IMAGE_WIDTH = 480;

function textBlockParagraphs(block) {
  const lines = (block.text || "").split("\n");
  return lines.map(
    (line) =>
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: line, size: 28 })], // 14pt
      }),
  );
}

function imageBlockParagraphs(block) {
  const paragraphs = [];
  try {
    const { width, height } = fitWithin(
      block.width,
      block.height,
      DOCX_MAX_IMAGE_WIDTH,
    );
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 60 },
        children: [
          new ImageRun({
            type: imageTypeFromDataUrl(block.src),
            data: dataUrlToUint8Array(block.src),
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
        alignment: AlignmentType.CENTER,
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

function questionBlockParagraphs(block) {
  const meta = questionMeta(block.questionType);
  const color = meta.color.replace("#", "");
  const paragraphs = [];

  // Question prompt, prefixed with a colour-coded type label.
  paragraphs.push(
    new Paragraph({
      spacing: { before: 160, after: 80 },
      children: [
        new TextRun({ text: `[${meta.label}] `, bold: true, color, size: 22 }),
        new TextRun({
          text: block.prompt || "(no question text)",
          bold: true,
          size: 28,
        }),
      ],
    }),
  );

  if (block.questionType === "number") {
    paragraphs.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({ text: "Answer: ", italics: true, size: 24 }),
          new TextRun({
            text: block.answer ? String(block.answer) : "____________",
            size: 24,
          }),
        ],
      }),
    );
  } else if (block.questionType === "single") {
    paragraphs.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({ text: "Answer: ", italics: true, size: 24 }),
          new TextRun({ text: block.answer || "____________", size: 24 }),
        ],
      }),
    );
  } else if (block.questionType === "multiple") {
    const answers = (block.answers || [])
      .map((a) => (a.text || "").trim())
      .filter(Boolean);
    paragraphs.push(
      new Paragraph({
        spacing: { after: answers.length ? 40 : 120 },
        children: [
          new TextRun({ text: "Answers:", italics: true, size: 24 }),
          ...(answers.length ? [] : [new TextRun({ text: " ____________", size: 24 })]),
        ],
      }),
    );
    answers.forEach((text) => {
      paragraphs.push(
        new Paragraph({
          spacing: { after: 40 },
          indent: { left: 360 },
          children: [new TextRun({ text: `• ${text}`, size: 24 })],
        }),
      );
    });
  } else if (block.questionType === "open") {
    const lines = Math.max(0, Number(block.answerLines) || 0);
    for (let i = 0; i < lines; i++) {
      paragraphs.push(
        new Paragraph({
          spacing: { after: 60 },
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 4,
              color: "cccccc",
              space: 2,
            },
          },
          children: [new TextRun({ text: "", size: 24 })],
        }),
      );
    }
  } else if (block.questionType === "background") {
    if (block.background) {
      paragraphs.push(
        new Paragraph({
          spacing: { after: 120 },
          indent: { left: 360 },
          children: [
            new TextRun({
              text: "Background: ",
              italics: true,
              bold: true,
              size: 22,
            }),
            new TextRun({
              text: block.background,
              italics: true,
              size: 22,
              color: "555555",
            }),
          ],
        }),
      );
    }
  }

  return paragraphs;
}

function sectionParagraphs(section) {
  const paragraphs = [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 280, after: 140 },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 6,
          color: "3b5bdb",
          space: 4,
        },
      },
      children: [
        new TextRun({
          text: section.name || "Untitled section",
          color: "3b5bdb",
        }),
      ],
    }),
  ];
  for (const block of section.blocks) {
    if (block.type === "text") {
      paragraphs.push(...textBlockParagraphs(block));
    } else if (block.type === "image" && block.src) {
      paragraphs.push(...imageBlockParagraphs(block));
    } else if (block.type === "question") {
      paragraphs.push(...questionBlockParagraphs(block));
    }
  }
  if (section.blocks.length === 0) {
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
  }
  return paragraphs;
}

// Build an in-memory docx Document from the lesson state.
export function buildDocument(doc) {
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        new TextRun({ text: doc.title || "Untitled Lesson", bold: true }),
      ],
    }),
  ];

  for (const section of doc.sections) {
    children.push(...sectionParagraphs(section));
  }

  return new Document({
    creator: "Spelling Lesson Maker",
    title: doc.title || "Untitled Lesson",
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 28 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 },
          },
        },
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

// Generate and download the .docx file.
export async function exportDocx(doc) {
  const document = buildDocument(doc);
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
