// Aggregated spelling words — the flat list of every word taught across the
// published lessons on the hub, served by the Worker's GET /spelling-words.json
// (rebuilt at most once every couple of days; see apps/api/src/routes/
// spelling-words.js). The homepage's floating-words animation pulls from this.

const API_URL = import.meta.env.VITE_API_URL;

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
 * Fetch the aggregated spelling words. Always resolves to a non-empty array of
 * strings: the server list when available, otherwise a small built-in fallback,
 * so the caller (the animation) never has to handle an empty state.
 * @returns {Promise<string[]>}
 */
export async function fetchSpellingWords() {
  if (!API_URL) return FALLBACK_WORDS;

  let res;
  try {
    res = await fetch(`${API_URL.replace(/\/$/, "")}/spelling-words.json`, {
      method: "GET",
    });
  } catch {
    return FALLBACK_WORDS;
  }
  if (!res.ok) return FALLBACK_WORDS;

  const data = await res.json().catch(() => null);
  const words = data && Array.isArray(data.words) ? data.words : [];
  const clean = words.filter((w) => typeof w === "string" && w.trim());
  return clean.length ? clean : FALLBACK_WORDS;
}
