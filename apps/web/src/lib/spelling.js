// Shared helpers for the "spelling words" block — an explicit, ordered list of
// the words a lesson is teaching. Imported by the editor (SectionCard /
// ContentBlock) and the docx exporter so the block shape stays in sync.

// Accent colour for the spelling-words block (chip + docx label + left border).
// Teal, distinct from the five question-type colours in questions.js.
export const SPELLING_COLOR = "#0c8599";

// Build a fresh spelling block. `newId` is injected so this stays decoupled from
// the id helper (same convention as createQuestionBlock). Words are stored as
// { id, text } objects — like the multiple-choice answers — so each row has a
// stable key for React and for the collaboration field tracking.
export function createSpellingBlock(newId) {
  return { id: newId(), type: "spelling", words: [{ id: newId(), text: "" }] };
}

// Pull every capitalized word out of the lesson's text blocks, in reading
// order, with duplicates removed. "Capitalized" means the word starts with an
// uppercase letter (covers ALL-CAPS too). Used by the spelling block's fill
// button to populate the list from the words already written into the passage.
export function extractCapitalizedWords(doc) {
  const text = (doc?.sections || [])
    .flatMap((s) => s.blocks || [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n");

  // A "word" is a run of letters, optionally with internal apostrophes or
  // hyphens (so "don't" and "well-being" stay intact).
  const tokens = text.match(/\p{L}[\p{L}'’-]*/gu) || [];
  const seen = new Set();
  const words = [];
  for (const word of tokens) {
    const first = word[0];
    // Keep only words whose first letter is an uppercase cased letter.
    if (first === first.toLocaleLowerCase()) continue;
    if (first !== first.toLocaleUpperCase()) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}
