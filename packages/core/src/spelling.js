// Shared helpers for the "spelling words" block — an explicit, ordered list of
// the words a lesson is teaching. Imported by the editor (SectionCard /
// ContentBlock) and the docx exporter so the block shape stays in sync.

import { ANSWER_GAP } from "./questions.js";

// Accent colour for the spelling-words block (chip + docx label + left border).
// Teal, distinct from the six question-type colours in questions.js.
export const SPELLING_COLOR = "#0c8599";

// The label a printed lesson puts in front of the words. They print as one
// running line — "Spell: FIRST SECOND THIRD" — not a numbered list, so the
// block reads as a single instruction to the speller.
export const SPELLING_LABEL = "Spell:";

// What separates two words on that line — the same gap a question's several
// accepted answers are set apart by, so the two read alike on the page.
export const SPELLING_WORD_SEPARATOR = ANSWER_GAP;

// Build a fresh spelling block. `newId` is injected so this stays decoupled from
// the id helper (same convention as createQuestionBlock). Words are stored as
// { id, text } objects — like the multiple-choice answers — so each row has a
// stable key for React and for the collaboration field tracking.
export function createSpellingBlock(newId) {
  return { id: newId(), type: "spelling", words: [{ id: newId(), text: "" }] };
}

// Pull every ALL-CAPS word out of the lesson's text blocks, in reading order,
// with duplicates removed. "ALL-CAPS" means every cased letter in the word is
// uppercase (so "DOG" qualifies but "Dog" and "dog" do not). Used by the
// spelling block's fill button to populate the list from the words already
// written into the passage.
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
    // Keep only words that are entirely upper-case. Uppercasing must not change
    // the word, and it must differ from its lower-cased form (so it has at least
    // one cased letter and isn't, say, all apostrophes).
    if (word !== word.toLocaleUpperCase()) continue;
    if (word === word.toLocaleLowerCase()) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}
