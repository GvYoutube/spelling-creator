// Per-page document metadata (title + Open Graph / Twitter tags).
//
// The app is a client-rendered SPA, so the static index.html carries only
// generic, site-wide tags. The Worker prerenders pages for crawlers with
// headless Chromium and captures the live DOM, so any tags this hook writes
// into <head> end up in the snapshot social/search scrapers receive. For real
// users it just keeps the browser tab title in sync with the current page.

import { useEffect } from "react";

const SITE_NAME = "Spelling Lesson Maker";
const DEFAULT_DESCRIPTION =
  "Create and print Spelling lessons with sections, text, and images.";

// Upsert (or remove, when content is empty) a single <meta> tag identified by
// the given attribute/key pair (e.g. name="description" or property="og:title").
function setMetaTag(attr, key, content) {
  const selector = `meta[${attr}="${key}"]`;
  let el = document.head.querySelector(selector);
  if (!content) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/**
 * Keep the document title and social/SEO meta tags in sync with the page.
 * @param {object}  meta
 * @param {string} [meta.title]        Page title; appended to the site name.
 * @param {string} [meta.description]  Meta/OG description (falls back to site default).
 * @param {string} [meta.image]        Absolute URL for the OG/Twitter preview
 *   image. Leave undefined to default to a live screenshot of the current page
 *   (rendered by the Worker's /og-image endpoint); pass null to opt out entirely.
 * @param {string} [meta.type]         OG type: "website" (default) or "article".
 */
export function useDocumentMeta({
  title,
  description,
  image,
  type = "website",
} = {}) {
  useEffect(() => {
    const fullTitle = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
    const desc = description || DEFAULT_DESCRIPTION;
    const { origin, pathname, href } = window.location;

    // Default the preview image to a screenshot of this page: the Worker's
    // /og-image endpoint renders the path with headless Chromium (the same
    // method used to prerender pages for crawlers). Pass `null` to opt out.
    const ogImage =
      image === undefined
        ? `${origin}/og-image?path=${encodeURIComponent(pathname)}`
        : image;

    document.title = fullTitle;
    setMetaTag("name", "description", desc);

    setMetaTag("property", "og:site_name", SITE_NAME);
    setMetaTag("property", "og:type", type);
    setMetaTag("property", "og:title", fullTitle);
    setMetaTag("property", "og:description", desc);
    setMetaTag("property", "og:url", href);
    setMetaTag("property", "og:image", ogImage);
    // The screenshot is a fixed-size PNG; advertise its dimensions/type so
    // scrapers can lay out the large-image card without fetching it first.
    setMetaTag("property", "og:image:width", ogImage ? "1200" : "");
    setMetaTag("property", "og:image:height", ogImage ? "630" : "");
    setMetaTag("property", "og:image:type", ogImage ? "image/png" : "");

    setMetaTag(
      "name",
      "twitter:card",
      ogImage ? "summary_large_image" : "summary",
    );
    setMetaTag("name", "twitter:title", fullTitle);
    setMetaTag("name", "twitter:description", desc);
    setMetaTag("name", "twitter:image", ogImage);
  }, [title, description, image, type]);
}

/**
 * Inject (and keep in sync) a single JSON-LD `<script>` in `<head>` for the
 * current page. Like useDocumentMeta, this exists for crawlers: the Worker's
 * prerendered snapshot captures whatever we write into the DOM, so search
 * engines receive the structured data even though the app is client-rendered.
 * The block is removed when the data clears or the page unmounts, so navigating
 * between routes never leaves stale structured data behind.
 * @param {object|null} data  A schema.org object to serialise, or null/undefined
 *   to emit nothing.
 */
export function useJsonLd(data) {
  // Serialise outside the effect so the dependency is a stable string: the
  // effect re-runs only when the structured data actually changes, not on every
  // render (a fresh object literal would otherwise look "new" each time).
  const json = data ? JSON.stringify(data) : "";
  useEffect(() => {
    if (!json) return undefined;
    const el = document.createElement("script");
    el.type = "application/ld+json";
    el.textContent = json;
    document.head.appendChild(el);
    return () => el.remove();
  }, [json]);
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
