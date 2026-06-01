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

/**
 * Build schema.org `Course` JSON-LD for a single lesson, following Google's
 * Course structured-data guidelines:
 * https://developers.google.com/search/docs/appearance/structured-data/course
 *
 * `name` and `description` are required; `provider` is recommended. The lessons
 * are free, so we also advertise a zero-price Offer and isAccessibleForFree —
 * accurate, and it improves eligibility for the richer "Course info" result.
 * Promotional text, pricing, and discounts are kept out of the title/description
 * per Google's content guidelines.
 *
 * @param {object}  opts
 * @param {object}  opts.lesson       Lesson summary/doc ({ title, author, createdAt }).
 * @param {string} [opts.description] Plain-text course summary (1–500 chars).
 * @param {string}  opts.url          Canonical URL of this lesson's page.
 * @param {string}  opts.origin       Site origin, used as the provider URL.
 * @returns {object|null}
 */
export function buildLessonCourseSchema({ lesson, description, url, origin }) {
  if (!lesson) return null;
  const course = {
    "@context": "https://schema.org",
    "@type": "Course",
    name: lesson.title || "Untitled Lesson",
    description:
      description ||
      `A spelling lesson${lesson.author ? ` by ${lesson.author}` : ""}.`,
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

/**
 * Build a schema.org `ItemList` carousel of lessons for a summary page (the
 * hub), per Google's "summary page + detail pages" list format: each ListItem
 * carries only its position and the canonical URL of a lesson page, where the
 * full Course markup lives (see buildLessonCourseSchema). Google needs at least
 * three items to render a carousel, but emitting fewer is harmless.
 *
 * @param {object}        opts
 * @param {Array<{id}>}   opts.lessons  Published lesson summaries, in display order.
 * @param {string}        opts.origin   Site origin, used to build each lesson URL.
 * @returns {object|null}
 */
export function buildLessonListSchema({ lessons, origin }) {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: lessons.map((lesson, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${origin}/hub/${lesson.id}`,
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
