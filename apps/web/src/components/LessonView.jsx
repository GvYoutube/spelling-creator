// Read-only renderer for a lesson document, used by the public lesson page.
//
// This replaces the old docx→mammoth preview pipeline on the viewer: instead of
// building a full Word document in memory, fetching+transcoding every image up
// front and re-inlining them as base64, we render each block directly as React
// and let the browser lazy-load images natively (loading="lazy"). The page shows
// as soon as the JSON is fetched; images stream in as they scroll into view.
//
// It reuses the same PREVIEW_STYLES CSS and the same image-sizing math the docx
// export uses (fitWithin against DOCX_MAX_IMAGE_WIDTH × the picked scale), so the
// published view is visually identical to the Word/PDF export. The export/PDF
// buttons still use the docx pipeline (docxExport.js / pdfExport.js) unchanged.

import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import { PREVIEW_STYLES } from "../lib/htmlPreview.js";
import { fitWithin, imageSizeScale } from "../lib/image.js";
import { DOCX_MAX_IMAGE_WIDTH } from "../lib/docxExport.js";
import { useImageSrc } from "../lib/useImageSrc.js";
import { questionMeta } from "../lib/questions.js";
import { SPELLING_COLOR } from "../lib/spelling.js";

const BLANK = "____________";

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
        // page doesn't shift as the lazily-loaded bytes arrive. The PREVIEW_STYLES
        // `img` rule (width:100%;height:auto) makes it fill the figure.
        <img
          src={src}
          alt={block.caption || "lesson image"}
          width={Math.round(width)}
          height={Math.round(height)}
          loading="lazy"
          decoding="async"
        />
      ) : (
        // Local blobs resolve asynchronously; show a sized skeleton (not a
        // spinner) so there's no layout shift when the URL arrives.
        <Skeleton
          variant="rectangular"
          sx={{ width: "100%", aspectRatio: `${width} / ${height}` }}
        />
      )}
      {block.caption ? (
        <figcaption
          style={{
            textAlign: "center",
            fontStyle: "italic",
            color: "#555",
            fontSize: "12px",
            marginTop: "6px",
          }}
        >
          {block.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

function QuestionBlock({ block }) {
  const meta = questionMeta(block.questionType);
  const answers = (block.answers || [])
    .map((a) => (a.text || "").trim())
    .filter(Boolean);

  return (
    <>
      <p>
        <strong>
          <span style={{ color: meta.color }}>[{meta.label}]</span>{" "}
          {block.prompt || "(no question text)"}
        </strong>
      </p>

      {(block.questionType === "number" ||
        block.questionType === "single" ||
        block.questionType === "background") && (
        <p>
          <em>Answer: </em>
          {block.answer ? String(block.answer) : BLANK}
        </p>
      )}

      {block.questionType === "open" && <p>{BLANK}</p>}

      {block.questionType === "multiple" && (
        <>
          <p>
            <em>Answers:</em>
            {answers.length ? "" : ` ${BLANK}`}
          </p>
          {answers.map((text, i) => (
            <p key={i} style={{ marginLeft: "24px" }}>
              • {text}
            </p>
          ))}
        </>
      )}
    </>
  );
}

function SpellingBlock({ block }) {
  const words = (block.words || [])
    .map((w) => (w.text || "").trim())
    .filter(Boolean);

  return (
    <>
      <p>
        <strong style={{ color: SPELLING_COLOR }}>Spelling words</strong>
      </p>
      {words.length ? (
        words.map((word, i) => (
          <p key={i} style={{ marginLeft: "24px" }}>
            {i + 1}. {word}
          </p>
        ))
      ) : (
        <p>
          <em>(no spelling words yet)</em>
        </p>
      )}
    </>
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
  const sections = doc?.sections || [];
  return (
    <Box
      className="s2c-preview-root"
      sx={{ bgcolor: "#fff", color: "#1a1a1a", p: { xs: 2, sm: 3 } }}
    >
      <style>{PREVIEW_STYLES}</style>
      <h1>{doc?.title || "Untitled Lesson"}</h1>
      {sections.map((section, si) => (
        <section key={section.id || si}>
          <h2>{section.name || "Untitled section"}</h2>
          {(section.blocks || []).map((block, bi) => (
            <Block key={block.id || bi} block={block} />
          ))}
        </section>
      ))}
    </Box>
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
