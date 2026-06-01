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
 * @param {string} [meta.image]        Absolute URL for the OG/Twitter preview image.
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
    const url = window.location.href;

    document.title = fullTitle;
    setMetaTag("name", "description", desc);

    setMetaTag("property", "og:site_name", SITE_NAME);
    setMetaTag("property", "og:type", type);
    setMetaTag("property", "og:title", fullTitle);
    setMetaTag("property", "og:description", desc);
    setMetaTag("property", "og:url", url);
    setMetaTag("property", "og:image", image);

    setMetaTag(
      "name",
      "twitter:card",
      image ? "summary_large_image" : "summary",
    );
    setMetaTag("name", "twitter:title", fullTitle);
    setMetaTag("name", "twitter:description", desc);
    setMetaTag("name", "twitter:image", image);
  }, [title, description, image, type]);
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
