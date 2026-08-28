// The one presentation constant every way of rendering a lesson shares: the docx
// export, the mammoth-backed PDF, and the read-only viewer (LessonView) that
// draws both the public lesson page and the editor's preview dialog.
//
// This lives here — outside `browser/` and free of dependencies — deliberately.
// It used to sit next to the code that first needed it (browser/docxExport.js),
// which meant importing the constant dragged in `docx` + `mammoth` (~1.1 MB of
// source). LessonView.jsx wants only this value, so it was paying for the whole
// Word pipeline just to show a lesson.
//
// Being outside `browser/` is also what lets the server render a lesson: the
// `core/browser/*` tier needs a DOM and is unreachable from the Worker by
// design (see .oxlintrc.json), and `/hub/:id` is server-rendered.

// Max image width inside the docx page (in px; docx maps px→EMU internally). The
// PDF and viewer paths both reuse this number so an image is the identical size
// everywhere.
export const DOCX_MAX_IMAGE_WIDTH = 480;

// ---------------------------------------------------------------------------
// The printed lesson's title block and page footer.
//
// A printed lesson opens with its title, a by-line and a line or two of "who is
// this pitched at" metadata, and every page closes with a copyright line above
// the question-type legend. The docx builds these as Word paragraphs and the PDF
// draws them with jsPDF, so the *text* of each is decided here once and both
// paths render the same strings.
//
// Everything is derived from the lesson itself — `doc.ageRange` and the record's
// author and publication date. Nothing about any particular publisher is baked
// in: a lesson with no author and no publication date simply prints without
// those lines.
// ---------------------------------------------------------------------------

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// A publication date written as a plain calendar day, with no time and no zone.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Parse whatever the lesson record carries as a publication date (an ISO string,
// a timestamp, or a Date) into a Date, or null when it isn't usable.
//
// A date-only string is deliberately not handed to `new Date()`: the spec reads
// "2026-01-01" as UTC midnight, so everything below — which asks the Date for its
// *local* month and year — would print "December 2025" for a lesson released on
// New Year's Day anywhere west of Greenwich. A calendar day carries no zone, so
// it's built as that day in local time and comes back out as the day it says.
// Anything with a time in it is a real instant and keeps the standard parse.
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const civil = DATE_ONLY.exec(value.trim());
    if (civil) {
      const date = new Date(
        Number(civil[1]),
        Number(civil[2]) - 1,
        Number(civil[3]),
      );
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The centred lines under the lesson title, in order. The first is the by-line;
 * the rest are the lesson's age range and release month when it has them.
 *
 * @param {object} doc  the lesson document ({ title, ageRange, sections })
 * @param {{author?: string, published?: string|number|Date}} [meta]
 * @returns {Array<{text: string, bold: boolean}>}
 */
export function lessonTitleLines(doc, meta = {}) {
  const lines = [];
  const author = (meta.author || "").trim();
  if (author) lines.push({ text: `By ${author}`, bold: true });

  const ageRange = (doc?.ageRange || "").trim();
  if (ageRange) lines.push({ text: `Ages: ${ageRange}`, bold: false });

  const published = toDate(meta.published);
  if (published) {
    const month = MONTHS[published.getMonth()];
    lines.push({
      text: `Released ${month} ${published.getFullYear()}`,
      bold: false,
    });
  }
  return lines;
}

/**
 * The copyright line printed at the foot of every page, or "" when the lesson
 * has no author to attribute it to.
 *
 * @param {{author?: string, published?: string|number|Date}} [meta]
 * @returns {string}
 */
export function lessonCopyright(meta = {}) {
  const author = (meta.author || "").trim();
  if (!author) return "";
  const year = (toDate(meta.published) || new Date()).getFullYear();
  return `© ${year} ${author}`;
}

// What separates two entries in the footer's question-type legend.
export const LEGEND_SEPARATOR = " | ";

// A Word paragraph style put on the by-line and age/release lines. mammoth drops
// paragraph alignment when it converts the docx, so the PDF would print these
// flush left; the style gives it something to map onto a class the print
// stylesheet can centre again. Same trick as the question character styles.
export const TITLE_LINE_STYLE_ID = "s2cTitleLine";
export const TITLE_LINE_STYLE_NAME = "S2C Title Line";
export const TITLE_LINE_CLASS = "s2c-title-line";

// Word's own built-in Title style, which the lesson title uses. mammoth has no
// default mapping for it, so without this the title arrives as an ordinary
// left-aligned paragraph while the by-line under it is centred.
export const TITLE_STYLE_NAME = "Title";
export const TITLE_CLASS = "s2c-title";

// Question paragraphs. They print tight against one another — a run of
// colour-coded lines, not a list of separated headings — which needs a class of
// their own, since mammoth carries none of the docx's paragraph spacing over.
export const QUESTION_LINE_STYLE_ID = "s2cQuestionLine";
export const QUESTION_LINE_STYLE_NAME = "S2C Question Line";
export const QUESTION_LINE_CLASS = "s2c-question-line";
