// Read-only renderer for a lesson document, used by the public lesson page and
// by the editor's preview mode.
//
// This replaces the old docx→mammoth preview pipeline: instead of building a
// full Word document in memory, fetching+transcoding every image up front and
// re-inlining them as base64, we render each block directly as React and let the
// browser lazy-load images natively (loading="lazy"). The page shows as soon as
// the JSON is fetched; images stream in as they scroll into view. Previewing is
// therefore instant, and a writer previews exactly what a reader will see.
//
// It keeps the docx export's image-sizing math (fitWithin against
// DOCX_MAX_IMAGE_WIDTH × the picked scale), so a lesson has the same proportions
// here as in the Word/PDF export — but it is drawn in the app's own theme, light
// or dark, exactly like interactive mode. A lesson is something you read on
// screen far more often than you print it, and a white sheet glaring out of a
// dark page is the wrong default for reading. The printout still looks like a
// printout: that's what Export DOCX and Print PDF produce (docxExport.js /
// pdfExport.js), the only two paths that build a Word file.

import { useTranslation } from "react-i18next";
import { Skeleton } from "./ui/skeleton.jsx";
import { fitWithin, imageSizeScale } from "@spelling-creator/core/image";
import { DOCX_MAX_IMAGE_WIDTH } from "@spelling-creator/core/lessonLayout";
import { useImageSrc } from "../lib/useImageSrc.js";
import {
  ANSWER_GAP,
  questionAnswerText,
  questionMeta,
} from "@spelling-creator/core/questions";
import {
  SPELLING_COLOR,
  SPELLING_WORD_SEPARATOR,
} from "@spelling-creator/core/spelling";

// The document's own typography, in theme colours: same sizes and spacing the
// docx uses, so the page keeps its shape, with the paper colours and the Word
// typeface replaced by the theme's.
//
// The question-type and spelling colours stay literal, as they are in the editor
// and in interactive mode: they're content — the same colour coding the docx
// carries — rather than chrome. But they were picked to sit on white paper, and
// measured against the themed card most of them miss the 4.5:1 AA floor for
// 14px bold: ~2.9:1 (purple) to ~3.8:1 (teal) on the dark card, and 3.2–3.5:1
// for green/orange/pink on the light one. So a label passes its own colour in as
// `--s2c-label` and the theme adjusts its lightness — darker on light, lighter
// on dark, hue untouched, so the colour coding still reads as itself. Measured
// after the mix: 5.7–8.4:1 across both themes.
//
// The docx and PDF keep the raw colours: they land on real white paper, which is
// what the palette was chosen for.
//
// Both the media query and the [data-theme] attribute are covered because both
// select the dark palette: the attribute is authoritative once colorScheme.jsx
// has run, the media query is what applies before that (and it must not fire
// when the reader has explicitly chosen light).
const LESSON_STYLES = `
  .s2c-lesson-root {
    color: var(--foreground);
    line-height: 1.5;
    font-size: 14px;
  }
  .s2c-lesson-root h1 {
    text-align: center;
    font-size: 26px;
    margin: 0 0 24px;
    color: var(--foreground);
  }
  .s2c-lesson-root p { margin: 0 0 6px; }
  .s2c-lesson-root .s2c-spelling { margin-top: 14px; }
  .s2c-lesson-root figure { margin: 0; }
  .s2c-lesson-root img {
    display: block;
    width: 100%;
    height: auto;
  }
  .s2c-lesson-root figcaption {
    text-align: center;
    font-style: italic;
    color: var(--muted-foreground);
    font-size: 12px;
    margin-top: 6px;
  }
  .s2c-lesson-root .s2c-label {
    color: color-mix(in oklab, var(--s2c-label) 78%, black);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .s2c-lesson-root .s2c-label {
      color: color-mix(in oklab, var(--s2c-label) 60%, white);
    }
  }
  :root[data-theme="dark"] .s2c-lesson-root .s2c-label {
    color: color-mix(in oklab, var(--s2c-label) 60%, white);
  }
`;

// Render a text block: each newline becomes its own paragraph, matching how the
// docx export splits lines into separate paragraphs.
function TextBlock({ block }) {
  const lines = (block.text || "").split("\n");
  return lines.map((line, i) => <p key={i}>{line || " "}</p>);
}

// The figure margins that place the image left / center / right — the same rule
// the old layoutImageFigures used, so alignment matches the export.
function figureMargin(align) {
  if (align === "left") return "16px auto 16px 0";
  if (align === "right") return "16px 0 16px auto";
  return "16px auto";
}

function ImageBlock({ block }) {
  const { t } = useTranslation("lesson");
  const src = useImageSrc(block);
  const align = block.align || "center";
  const { width, height } = fitWithin(
    block.width,
    block.height,
    DOCX_MAX_IMAGE_WIDTH * imageSizeScale(block.size),
  );

  return (
    <figure
      style={{
        display: "block",
        width: `${Math.round(width)}px`,
        maxWidth: "100%",
        margin: figureMargin(align),
      }}
    >
      {src ? (
        // width/height attributes reserve the correct aspect-ratio box so the
        // page doesn't shift as the lazily-loaded bytes arrive. The
        // LESSON_STYLES `img` rule (width:100%;height:auto) fills the figure.
        <img
          src={src}
          alt={block.caption || t("lessonView.imageAlt")}
          width={Math.round(width)}
          height={Math.round(height)}
          loading="lazy"
          decoding="async"
        />
      ) : (
        // Local blobs resolve asynchronously; show a sized skeleton (not a
        // spinner) so there's no layout shift when the URL arrives.
        <Skeleton
          className="w-full rounded-none"
          style={{ aspectRatio: `${width} / ${height}` }}
        />
      )}
      {/* Styled by LESSON_STYLES, so the caption follows the theme with the
          rest of the page. */}
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
    </figure>
  );
}

// A question reads the way it prints: the prompt in the colour of its type, then
// its answer in the body colour on the same line. Nothing is labelled — the
// colour is what marks the type — so this matches the exported lesson exactly.
function QuestionBlock({ block }) {
  const { t } = useTranslation("lesson");
  const meta = questionMeta(block.questionType);
  const answer = questionAnswerText(block);
  const steps = (block.steps || []).filter((s) => (s.text || "").trim());

  return (
    <>
      <p>
        <span className="s2c-label" style={{ "--s2c-label": meta.color }}>
          {block.prompt || t("lessonView.noQuestionText")}
        </span>
        {answer ? `${ANSWER_GAP}${answer}` : null}
      </p>

      {steps.map((step, i) => (
        <p key={step.id} style={{ marginLeft: "24px" }}>
          {i + 1}. {step.text}
        </p>
      ))}
    </>
  );
}

// The words print as one running line after the label, not a numbered list.
function SpellingBlock({ block }) {
  const { t } = useTranslation("lesson");
  const words = (block.words || [])
    .map((w) => (w.text || "").trim())
    .filter(Boolean);

  return (
    <p className="s2c-spelling">
      <strong className="s2c-label" style={{ "--s2c-label": SPELLING_COLOR }}>
        {t("lessonView.spellingWordsLabel")}
      </strong>{" "}
      {words.length ? (
        words.join(SPELLING_WORD_SEPARATOR)
      ) : (
        <em>{t("lessonView.noSpellingWords")}</em>
      )}
    </p>
  );
}

function Block({ block }) {
  if (block.type === "text") return <TextBlock block={block} />;
  if (block.type === "image" && (block.image || block.src))
    return <ImageBlock block={block} />;
  if (block.type === "question") return <QuestionBlock block={block} />;
  if (block.type === "spelling") return <SpellingBlock block={block} />;
  return null;
}

// Render a whole lesson document read-only. `doc` is the lesson body:
// { title, sections: [{ name, blocks: [...] }] }.
export default function LessonView({ doc }) {
  const { t } = useTranslation("lesson");
  const sections = doc?.sections || [];
  return (
    <div className="s2c-lesson-root p-4 text-foreground sm:p-6">
      <style>{LESSON_STYLES}</style>
      <h1>{doc?.title || t("lessonView.untitledLesson")}</h1>
      {sections.map((section, si) => (
        // data-section-id and scroll-mt are the same anchor contract SectionCard
        // publishes in the editor, so the section outline can scroll to a
        // section here without knowing which of the two surfaces it is looking
        // at — see SectionOutline. The two never coexist: preview replaces the
        // editing panes rather than sitting beside them, so one id matches one
        // element. On the public lesson page nothing queries these, and an
        // unused data attribute costs nothing.
        // A section prints no heading of its own: its name is an organising
        // device for the editor, and a finished lesson runs straight through.
        <section
          key={section.id || si}
          data-section-id={section.id}
          className="scroll-mt-(--header-h)"
        >
          {(section.blocks || []).map((block, bi) => (
            <Block key={block.id || bi} block={block} />
          ))}
        </section>
      ))}
    </div>
  );
}

// Plain-text summary of a lesson document, in reading order, for the page's
// meta/SEO description. Pulls the actual lesson prose — text, question prompts
// and spelling words — so the description leads with content, without rendering
// the document to a string first. Image captions are skipped on purpose: they're
// usually attribution boilerplate ("Image by … via Wikimedia Commons") that
// reads as noise at the front of a social/search snippet.
export function lessonPlainText(doc) {
  const parts = [];
  for (const section of doc?.sections || []) {
    for (const block of section.blocks || []) {
      if (block.type === "text" && block.text) parts.push(block.text);
      else if (block.type === "question" && block.prompt)
        parts.push(block.prompt);
      else if (block.type === "spelling") {
        const words = (block.words || [])
          .map((w) => (w.text || "").trim())
          .filter(Boolean);
        if (words.length) parts.push(words.join(", "));
      }
    }
  }
  return parts.join(" ");
}
