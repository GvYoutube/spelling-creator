// Per-page document metadata (title + Open Graph / Twitter tags) and JSON-LD.
//
// These used to be hooks that reached into `document.head` from an effect,
// because the app was client-rendered and React 18 had no notion of document
// metadata. React 19 hoists `<title>`, `<meta>` and `<link>` into `<head>` from
// anywhere in the tree, so they are now ordinary JSX — which is what makes them
// work under SSR: a crawler receives the real tags in the served HTML rather
// than tags an effect writes after the bundle has run.
//
// (JSON-LD is deliberately *not* hoisted. React only hoists `<script>` when it
// is `async`, and an async JSON-LD block would be meaningless — the type isn't
// executable. It renders in place instead, which search engines accept: the
// spec allows `application/ld+json` anywhere in the document.)

import { useLocation } from "react-router-dom";
import { useSiteOrigin } from "./ssr.jsx";

const SITE_NAME = "Spelling Lesson Maker";
const DEFAULT_DESCRIPTION =
  "Create and print Spelling lessons with sections, text, and images.";

/**
 * Document title and social/SEO meta tags for the current page. Render it
 * anywhere in a page's tree; React puts the tags in `<head>`.
 *
 * @param {object}  props
 * @param {string} [props.title]        Page title; appended to the site name.
 * @param {string} [props.description]  Meta/OG description (falls back to the site default).
 * @param {string} [props.image]        Absolute URL for the OG/Twitter preview
 *   image. Leave undefined to default to a live screenshot of the current page
 *   (rendered by the Worker's /og-image endpoint); pass null to opt out entirely.
 * @param {string} [props.type]         OG type: "website" (default) or "article".
 */
export function DocumentMeta({ title, description, image, type = "website" }) {
  const origin = useSiteOrigin();
  const { pathname } = useLocation();

  const fullTitle = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
  const desc = description || DEFAULT_DESCRIPTION;

  // Default the preview image to a screenshot of this page: the Worker's
  // /og-image endpoint renders the path with headless Chromium. Pass `null` to
  // opt out.
  const ogImage =
    image === undefined
      ? `${origin}/og-image?path=${encodeURIComponent(pathname)}`
      : image;

  return (
    <>
      <title>{fullTitle}</title>
      <meta name="description" content={desc} />

      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={desc} />
      <meta property="og:url" content={`${origin}${pathname}`} />
      {ogImage && (
        <>
          <meta property="og:image" content={ogImage} />
          {/* The screenshot is a fixed-size PNG; advertise its dimensions/type
              so scrapers can lay out the large-image card without fetching it. */}
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:image:type" content="image/png" />
        </>
      )}

      <meta
        name="twitter:card"
        content={ogImage ? "summary_large_image" : "summary"}
      />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={desc} />
      {ogImage && <meta name="twitter:image" content={ogImage} />}
    </>
  );
}

/**
 * A single JSON-LD block for the current page, or nothing when there's no data.
 * @param {object} props
 * @param {object|null} [props.data]  A schema.org object to serialise.
 */
export function JsonLd({ data }) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      // JSON.stringify escapes nothing HTML-significant on its own, so close
      // the one hole that matters: a "</script>" inside any string value would
      // otherwise end the block early. Escaping every "<" keeps the JSON
      // identical to a parser while making the sequence inert to the HTML one.
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

// Build the bare schema.org `Course` object (no top-level @context, so it can
// either stand alone or be embedded inside an ItemList). `name`, `description`,
// and `provider` are the properties Google's Course list feature requires; the
// lessons are free, so we also advertise a zero-price Offer and
// isAccessibleForFree (accurate). Promotional text, pricing, and discounts are
// kept out of the name/description per Google's content guidelines.
function courseObject({ lesson, description, url, origin }) {
  const course = {
    "@type": "Course",
    name: lesson.title || "Untitled Lesson",
    description: description || summaryDescription(lesson),
    inLanguage: "en",
    isAccessibleForFree: true,
    provider: {
      "@type": "Organization",
      name: SITE_NAME,
      url: origin,
    },
    offers: {
      "@type": "Offer",
      category: "Free",
      price: "0",
      priceCurrency: "USD",
    },
  };
  if (url) course.url = url;
  if (lesson.author) {
    course.author = { "@type": "Person", name: lesson.author };
  }
  if (lesson.createdAt) {
    // schema.org dateCreated expects ISO 8601; skip an unparseable value.
    const d = new Date(lesson.createdAt);
    if (!Number.isNaN(d.getTime())) course.dateCreated = d.toISOString();
  }
  return course;
}

// Fallback Course description from a lesson summary (which carries no body
// text), used on the hub carousel where the full rendered text isn't available.
function summaryDescription(lesson) {
  const sections =
    typeof lesson.sectionCount === "number"
      ? ` with ${lesson.sectionCount} section${lesson.sectionCount === 1 ? "" : "s"}`
      : "";
  return `A printable spelling lesson${sections} to practise and learn.`;
}

/**
 * Build standalone schema.org `Course` JSON-LD for a single lesson's page.
 *
 * NOTE: a lone Course corresponds to Google's "Course info" rich result, which
 * Google retired in September 2025 — so this no longer produces a visual rich
 * result on its own. It's kept because it's valid, accurate semantic data that
 * helps Google understand the page, and it's the per-lesson detail markup the
 * hub's Course-list carousel (see buildLessonListSchema) points at. The carousel
 * on the hub is the markup that actually still renders as a rich result.
 *
 * @param {object}  opts
 * @param {object}  opts.lesson       Lesson summary/doc ({ title, author, createdAt }).
 * @param {string} [opts.description] Plain-text course summary (1–500 chars).
 * @param {string}  opts.url          Canonical URL of this lesson's page.
 * @param {string}  opts.origin       Site origin, used as the provider URL.
 * @returns {object|null}
 */
export function buildLessonCourseSchema(opts) {
  if (!opts.lesson) return null;
  return { "@context": "https://schema.org", ...courseObject(opts) };
}

/**
 * Build a schema.org `ItemList` of Courses for the hub — Google's Course list
 * (carousel) rich result, which (unlike the deprecated Course info) is still
 * supported: https://developers.google.com/search/docs/appearance/structured-data/course
 *
 * Each ListItem embeds a FULL named Course (name + description + provider), as
 * the carousel requires — a URL-only list is rejected as "unnamed items".
 * Google needs at least three courses to render the carousel, so this returns
 * null below that threshold rather than emit markup that can never qualify.
 *
 * @param {object}        opts
 * @param {Array<object>} opts.lessons  Published lesson summaries, in display order.
 * @param {string}        opts.origin   Site origin, for provider + per-lesson URLs.
 * @returns {object|null}
 */
export function buildLessonListSchema({ lessons, origin }) {
  // Below Google's three-course minimum the carousel can't appear, so emit
  // nothing rather than markup that will never qualify.
  if (!Array.isArray(lessons) || lessons.length < 3) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: lessons.map((lesson, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: courseObject({
        lesson,
        url: `${origin}/hub/${lesson.id}`,
        origin,
      }),
    })),
  };
}

// Collapse rendered HTML to a short plain-text summary suitable for a meta
// description. Strips tags/entities, squashes whitespace, and truncates.
export function htmlToDescription(html, max = 160) {
  if (!html) return "";
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
