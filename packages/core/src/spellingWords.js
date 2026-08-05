// Aggregated spelling words — the flat list of every word taught across the
// published lessons on the hub, served by the Worker's GET /spelling-words.json
// (rebuilt at most once every couple of days; see apps/api/src/routes/
// spelling-words.js). The homepage's floating-words animation pulls from this.
import { apiUrl, hasApi } from "./config.js";

// A small built-in word list so the homepage animation still has something to
// show when no backend is configured (or the fetch fails / returns nothing).
const FALLBACK_WORDS = [
  "spelling",
  "practice",
  "lesson",
  "teacher",
  "student",
  "letters",
  "phonics",
  "reading",
  "writing",
  "vocabulary",
  "alphabet",
  "syllable",
  "communicate",
  "literacy",
  "learning",
];

/**
 * A spelling row can hold anything a teacher typed, including phrases ("ice
 * cream"). The animation renders each entry as one drifting particle, and a
 * multi-word phrase makes for an ugly one — it is scaled by character count, so
 * it comes out tiny and stretched, and can break across the hero's edges. Only
 * single words are usable, so anything containing whitespace is dropped.
 * @param {unknown} word
 * @returns {boolean}
 */
function isSingleWord(word) {
  return (
    typeof word === "string" && word.trim() !== "" && !/\s/.test(word.trim())
  );
}

/**
 * Fetch the aggregated spelling words. Always resolves to a non-empty array of
 * single-word strings: the server list when available, otherwise a small
 * built-in fallback, so the caller (the animation) never has to handle an empty
 * state.
 * @returns {Promise<string[]>}
 */
export async function fetchSpellingWords() {
  if (!hasApi()) return FALLBACK_WORDS;

  let res;
  try {
    res = await fetch(`${apiUrl()}/spelling-words.json`, {
      method: "GET",
    });
  } catch {
    return FALLBACK_WORDS;
  }
  if (!res.ok) return FALLBACK_WORDS;

  const data = await res.json().catch(() => null);
  const words = data && Array.isArray(data.words) ? data.words : [];
  const clean = words.filter(isSingleWord).map((w) => w.trim());
  return clean.length ? clean : FALLBACK_WORDS;
}
