// Lesson-standard validation — the mechanically checkable half of the authoring
// standard stated in standards.md.
//
// The split between the two files is deliberate. standards.md carries the rules
// that need judgement ("a tight open must be answerable instantly"), and it only
// reaches the model if the client surfaces server instructions or tool
// descriptions. This module decides the rules a script can decide on its own, on
// the way into a write, so they hold even when the model never read a word of the
// standard.
//
// Errors reject the write; warnings ride along with a successful one. The line
// between them is whether a legitimate lesson could ever trip the check: a green
// answer that is not in its own passage is always a defect, whereas a five-section
// lesson is usually a mistake and occasionally exactly what the user asked for.
// `skipValidation: true` on the writing tools turns the errors off for the rare
// case where the user genuinely wants something the standard forbids.
//
// Every message names the section, the offending value, and the fix, because the
// model reads the rejection and resubmits: "validation failed" buys a guess, a
// specific message buys a correction in one round trip.

import { richTextToPlain } from "@spelling-creator/core/richText";

/** The default lesson shape (see standards.md). Deviations are warnings. */
export const SECTION_COUNT = 6;
export const SPELLING_WORDS_PER_SECTION = 4;
export const SPELLING_MIN_LETTERS = 6;
export const SPELLING_MAX_LETTERS = 9;

// The fixed per-section question order: 3 green, 2 purple, 2 orange, 1 blue,
// then 7 pink (4 tight opens followed by 3 extended opens).
const QUESTION_ORDER = [
  "single",
  "single",
  "single",
  "number",
  "number",
  "multiple",
  "multiple",
  "background",
  "open",
  "open",
  "open",
  "open",
  "open",
  "open",
  "open",
];
const TIGHT_OPENS = 4;
const EXTENDED_OPENS = 3;
const ORANGE_MIN_ANSWERS = 2;
const ORANGE_MAX_ANSWERS = 4;

// A private stand-in for a decimal point, so the punctuation strip can run
// without special-casing "." and without keeping sentence-ending full stops.
const DECIMAL_MARK = "\u0001";
const PUNCTUATION = new RegExp(`[^\\p{L}\\p{N}${DECIMAL_MARK}]+`, "gu");

// The orange list check needs the one piece of punctuation every other check
// throws away — the comma that turns two nouns into a series — so it gets its own
// stand-in and its own strip. See listTokens().
const COMMA_MARK = "\u0002";
const LIST_PUNCTUATION = new RegExp(
  `[^\\p{L}\\p{N}${DECIMAL_MARK}${COMMA_MARK}]+`,
  "gu",
);
// What separates one member of a list from the next: a comma or semicolon (both
// become COMMA_MARK) and the conjunctions. Anything else between two items means
// they were never written as a series.
const LIST_SEPARATORS = new Set([COMMA_MARK, "AND", "OR"]);
// How much prose may sit between two list items. "red-hot rock, choking gas, and
// clouds of ash" needs two ("clouds of"; the comma and "and" are separators);
// "a scale called the VEI, the Volcanic Explosivity Index" needs six, and is not
// a list.
const MAX_LIST_GAP_WORDS = 4;
// The blank an orange prompt puts where the passage's list was. Three underscores
// is the floor; lessons in practice write five or six.
const ORANGE_BLANK = /_{3,}/;

// Retired because it was overused to the point of becoming a tic. Matched
// loosely so rephrasings ("name a word that comes to mind") are caught too.
const RETIRED_STEM = /\bwords?\s+that\s+comes?\s+to\s+mind\b/i;

// Heuristics for telling a tight open from an extended one, used only by the
// W_OPEN_SPLIT warning. Word count alone misclassifies short extended opens
// ("In your own words, explain why."), so the stems get the first say.
const EXTENDED_STEM =
  /in your own words|defend your (answer|thinking|choice)|explain your (thinking|answer|reasoning|choice)|explain why|explain how|why do you think|describe (how|why|what)/i;
const TIGHT_STEM =
  /^\s*name\s+(a|an|one|some|something|someone|a kind|a type|a place|a way)\b/i;
const TIGHT_OPEN_MAX_WORDS = 12;

/**
 * @typedef {object} Finding
 * @property {"error"|"warning"} level
 * @property {string} code            Stable machine code, e.g. "E_GROUNDING_SINGLE".
 * @property {string} key             Identity of the defect, stable across section renumbering.
 * @property {number|null} section    1-based section number, or null for lesson-wide findings.
 * @property {string} message         Self-correcting prose: what is wrong, where, and the fix.
 */

/**
 * Normalise text for comparison: uppercase, drop punctuation, collapse
 * whitespace. Two details matter and both caused false failures before they were
 * handled — thousands separators (the passage says "3,776" while the answer field
 * holds "3776") and decimal points (which must survive the punctuation strip).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  return (
    String(value ?? "")
      // "3,776" and "3776" are the same number written two ways.
      .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
      .toUpperCase()
      // Park decimal points out of the way of the punctuation strip and put
      // them back afterwards: "112.5" must survive as one token, while the
      // full stop in "MAGMA." must not.
      .replace(/(\d)\.(\d)/g, `$1${DECIMAL_MARK}$2`)
      .replace(PUNCTUATION, " ")
      .split(DECIMAL_MARK)
      .join(".")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Whole-word containment. `" CAT "` does not match inside `" CATALOGUE "`, which
// plain substring matching would wrongly accept. Both arguments are normalised.
function containsPhrase(haystack, needle) {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function wordsOf(normalized) {
  return normalized ? normalized.split(" ") : [];
}

function isSingleWord(normalized) {
  return wordsOf(normalized).length === 1;
}

function sectionLabel(section, index) {
  const name = typeof section?.name === "string" ? section.name.trim() : "";
  return name ? `Section ${index + 1} "${name}"` : `Section ${index + 1}`;
}

// The prose a grounding check compares against: the section's own text blocks,
// flattened out of rich text (a lesson round-tripped through the web editor
// carries HTML here) and normalised once.
function sectionPassage(blocks) {
  return normalizeText(
    blocks
      .filter((b) => b?.type === "text")
      .map((b) => richTextToPlain(b.text || ""))
      .join(" "),
  );
}

// One sentence's worth of tokens for the orange list check, with commas and
// semicolons kept as tokens of their own. Everything else matches normalizeText,
// so an option that compares equal to the passage there compares equal here.
function listTokens(sentence) {
  return sentence
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1") // "3,776" is a number, not a list
    .toUpperCase()
    .replace(/(\d)\.(\d)/g, `$1${DECIMAL_MARK}$2`)
    .replace(/[,;]/g, ` ${COMMA_MARK} `)
    .replace(LIST_PUNCTUATION, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.split(DECIMAL_MARK).join("."));
}

// The section's passage as tokenised sentences. A list lives inside one sentence
// — "rock, gas, and ash" — so the split is what stops two items that merely share
// a paragraph from reading as a series. Sentence enders only count when followed
// by a space, which leaves "12.5" whole.
function passageSentences(blocks) {
  return blocks
    .filter((b) => b?.type === "text")
    .map((b) => richTextToPlain(b.text || ""))
    .join(" ")
    .split(/[.!?]+(?=\s|$)/)
    .map(listTokens)
    .filter((tokens) => tokens.length);
}

// Are these two token positions adjacent members of a list? They must be joined
// by a separator (a comma or an "and"/"or") and sit within a few words of each
// other. Nothing between them is what "the Pacific Ocean" looks like; a clause
// between them is what "a scale called the VEI, the Volcanic Explosivity Index"
// looks like. Neither is a list.
function listSeparated(tokens, from, to) {
  const gap = tokens.slice(from + 1, to);
  if (!gap.some((t) => LIST_SEPARATORS.has(t))) return false;
  return (
    gap.filter((t) => !LIST_SEPARATORS.has(t)).length <= MAX_LIST_GAP_WORDS
  );
}

// Do all of `options` appear in one sentence as a single explicit series? Walks
// the option occurrences in text order and breaks the walk wherever two of them
// aren't list-separated, so a run has to be a real list to survive — and returns
// the first run that covers every option, or null if none does.
function findListRun(tokens, options) {
  const wanted = new Set(options);
  const hits = [];
  tokens.forEach((token, at) => {
    if (wanted.has(token)) hits.push({ token, at });
  });
  let run = [];
  const runCoversAll = () =>
    new Set(run.map((h) => h.token)).size === wanted.size;
  for (const [i, hit] of hits.entries()) {
    if (i > 0 && listSeparated(tokens, hits[i - 1].at, hit.at)) {
      run.push(hit);
      continue;
    }
    if (run.length && runCoversAll()) return run;
    run = [hit];
  }
  return run.length > 0 && runCoversAll() ? run : null;
}

const CONJUNCTIONS = new Set(["AND", "OR"]);
// How many words a list item may run to before what follows a conjunction reads
// as a clause instead. "and silt" and "and the chough" are items; "and the
// valley went dark" is a sentence carrying on.
const MAX_ITEM_WORDS = 2;

// The next item of the series after `at`, or null if the series ends there. An
// English series closes with "and X" / "or X", so what marks a run of accepted
// answers as unfinished is a conjunction after it with an item attached:
// "boulder, cobble" is unfinished in front of "and silt".
//
// The hard part is that the same conjunction also joins clauses — "…rock, gas,
// and ash, and the valley went dark" ends its list at ASH. Nothing short of
// parsing the sentence separates the two for certain, so length decides: an item
// is a word or two before the next separator or the sentence's end, a clause
// runs on. That misses a subset whose sentence continues unpunctuated past the
// last item, which is the safe direction to miss in — a false positive here
// blocks an author who did nothing wrong.
function nextListItemAfter(tokens, at) {
  const tail = tokens.slice(at + 1, at + 4 + MAX_LIST_GAP_WORDS);
  if (!tail.length || !LIST_SEPARATORS.has(tail[0])) return null;
  const conjunction = tail.findIndex((t) => CONJUNCTIONS.has(t));
  if (conjunction === -1) return null;

  const item = [];
  for (const token of tokens.slice(at + 2 + conjunction)) {
    if (LIST_SEPARATORS.has(token)) break;
    item.push(token);
  }
  if (!item.length || item.length > MAX_ITEM_WORDS) return null;
  return item.join(" ");
}

// The ALL-CAPS learning vocabulary a passage teaches. Two letters minimum so
// sentence-initial capitals are ignored; acronyms are picked up too, which is
// why reusing one as a spelling word is only a warning.
function capsVocabulary(blocks) {
  const plain = blocks
    .filter((b) => b?.type === "text")
    .map((b) => richTextToPlain(b.text || ""))
    .join(" ");
  const found = plain.match(/\b\p{Lu}[\p{Lu}'’-]+\b/gu) || [];
  return new Set(found.map(normalizeText).filter(Boolean));
}

function spellingWordsOf(blocks) {
  return blocks
    .filter((b) => b?.type === "spelling")
    .flatMap((b) => (Array.isArray(b.words) ? b.words : []))
    .map((w) => (typeof w === "string" ? w : w?.text) || "")
    .map((w) => w.trim())
    .filter(Boolean);
}

function answersOf(block) {
  if (block?.questionType === "multiple") {
    return (Array.isArray(block.answers) ? block.answers : [])
      .map((a) => (typeof a === "string" ? a : a?.text) || "")
      .map((a) => a.trim())
      .filter(Boolean);
  }
  const answer = block?.answer;
  if (answer == null || answer === "") return [];
  return [String(answer).trim()].filter(Boolean);
}

function hasSteps(block) {
  return Array.isArray(block?.steps) && block.steps.length > 0;
}

function letterCount(word) {
  return (word.match(/\p{L}/gu) || []).length;
}

function wordCount(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function openKind(prompt) {
  const text = String(prompt || "");
  if (EXTENDED_STEM.test(text)) return "extended";
  if (TIGHT_STEM.test(text)) return "tight";
  return wordCount(text) > TIGHT_OPEN_MAX_WORDS ? "extended" : "tight";
}

function numericKey(value) {
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : normalizeText(value);
}

// A collision names two parties, and which one the walk reaches first depends on
// section order — so moving a section would otherwise rewrite the key and make an
// untouched defect look newly introduced. Sorting makes the pair itself the
// identity, whichever end it was found from.
function pairKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}

/**
 * Check a built lesson document against the authoring standard.
 *
 * Operates on the canonical doc (the shape buildDoc/applyPatch produce and the
 * hub stores), so it covers every write path — create, update and patch alike —
 * without each tool restating the rules.
 *
 * @param {{ title?: string, sections?: any[] }} doc
 * @returns {{ errors: Finding[], warnings: Finding[] }}
 */
export function validateLesson(doc) {
  const sections = Array.isArray(doc?.sections) ? doc.sections : [];
  const findings = [];
  const report = (level, code, key, section, message) =>
    findings.push({ level, code, key: `${code}:${key}`, section, message });
  const error = (code, key, section, message) =>
    report("error", code, key, section, message);
  const warn = (code, key, section, message) =>
    report("warning", code, key, section, message);

  // Per-section context, computed once: the passage every grounding check reads,
  // the caps vocabulary, the spelling words, and the questions in order.
  const context = sections.map((section, i) => {
    const blocks = Array.isArray(section?.blocks) ? section.blocks : [];
    return {
      index: i,
      number: i + 1,
      id: section?.id || `section#${i}`,
      label: sectionLabel(section, i),
      blocks,
      passage: sectionPassage(blocks),
      // The same prose again, kept in sentences and with its commas, because the
      // orange list check needs both and no other check may have either.
      sentences: passageSentences(blocks),
      caps: capsVocabulary(blocks),
      spelling: spellingWordsOf(blocks),
      questions: blocks.filter((b) => b?.type === "question"),
    };
  });

  // Every text answer in the lesson, tagged with the question that owns it — the
  // input to the lesson-wide collision checks further down.
  const allAnswers = [];

  for (const ctx of context) {
    ctx.questions.forEach((block, qi) => {
      // Block ids are what make a finding's identity survive an edit elsewhere in
      // the lesson: they are generated once and carried through move_section,
      // move_block and replace_block alike. Position would not be.
      const questionId = block?.id || `${ctx.id}#q${qi}`;
      const answers = answersOf(block);
      const where = `${ctx.label}, question ${qi + 1}`;

      for (const answer of answers) {
        allAnswers.push({
          text: answer,
          norm: normalizeText(answer),
          questionId,
          questionType: block.questionType,
          section: ctx.number,
          where,
        });
      }

      switch (block.questionType) {
        case "single": {
          for (const answer of answers) {
            if (containsPhrase(ctx.passage, normalizeText(answer))) continue;
            error(
              "E_GROUNDING_SINGLE",
              `${questionId}:${normalizeText(answer)}`,
              ctx.number,
              `${ctx.label}: the answer "${answer}" does not appear in that section's passage. ` +
                "A green (single) answer must be findable, word for word, in the section's own text — " +
                "either add the wording to the passage or change the answer to match what the passage already says.",
            );
          }
          break;
        }

        case "multiple": {
          if (
            answers.length < ORANGE_MIN_ANSWERS ||
            answers.length > ORANGE_MAX_ANSWERS
          ) {
            warn(
              "W_ORANGE_ANSWER_COUNT",
              questionId,
              ctx.number,
              `${where}: this orange (multiple) question accepts ${answers.length} answer(s). ` +
                `Aim for ${ORANGE_MIN_ANSWERS}-${ORANGE_MAX_ANSWERS}, so the speller has a real choice without hunting.`,
            );
          }
          for (const answer of answers) {
            const norm = normalizeText(answer);
            if (!isSingleWord(norm)) {
              warn(
                "W_ORANGE_MULTIWORD",
                `${questionId}:${norm}`,
                ctx.number,
                `${where}: the accepted answer "${answer}" is more than one word. ` +
                  "Orange answers should be single words — a speller pointing to letters on a letterboard " +
                  "has to spell every one of them.",
              );
            }
            if (containsPhrase(ctx.passage, norm)) continue;
            if (isSingleWord(norm)) {
              error(
                "E_ORANGE_PARAPHRASED",
                `${questionId}:${norm}`,
                ctx.number,
                `${ctx.label}: the accepted answer "${answer}" does not appear in that section's passage. ` +
                  "Orange answers must be words the passage actually uses — do not paraphrase (if the text says " +
                  '"superheated", HOT is not an accepted answer), and do not ask for general knowledge ' +
                  '("name an ocean" is a blue background question, not an orange one).',
              );
            } else {
              error(
                "E_GROUNDING_MULTIPLE",
                `${questionId}:${norm}`,
                ctx.number,
                `${ctx.label}: the accepted answer "${answer}" does not appear in that section's passage. ` +
                  "Match the passage's own wording, and prefer a single concrete word the speller can find in the text.",
              );
            }
          }

          // The prompt is meant to quote the passage's sentence with the list
          // BLANKED OUT, so the speller recalls it. A prompt carrying its own
          // answers hands them over and tests nothing — the commonest orange
          // defect, and invisible unless something looks for it.
          const promptNorm = normalizeText(block.prompt || "");
          const given = answers.filter((a) =>
            containsPhrase(promptNorm, normalizeText(a)),
          );
          if (given.length) {
            error(
              "E_ORANGE_ANSWER_IN_PROMPT",
              `${questionId}:${given.map(normalizeText).sort().join("|")}`,
              ctx.number,
              `${where}: the prompt contains its own accepted answer${given.length === 1 ? "" : "s"} ` +
                `(${given.map((a) => `"${a}"`).join(", ")}), so there is nothing for the speller to recall. ` +
                'Blank the list out of the quoted sentence instead: not "Cats travelled with the Roman army, ' +
                'traders, and settlers — name one", but "Cats travelled with the Roman ______ — name one group."',
            );
          }

          // The prompt is also what tells the speller WHICH of the section's two
          // lists is being asked for. Quoting the sentence with its list blanked
          // out does that; "Name one." leaves them guessing. A prompt can
          // identify its list without a literal blank ("Which three trees line
          // the bank?"), so this one advises rather than blocks.
          if (!ORANGE_BLANK.test(block.prompt || "")) {
            warn(
              "W_ORANGE_NO_BLANK",
              questionId,
              ctx.number,
              `${where}: the prompt doesn't quote the passage's sentence with its list blanked out ` +
                '("The blast sent out ______. Name one thing the eruption threw out."). A section has two orange ' +
                'questions, so a bare "Name one." doesn\'t tell the speller which list is meant.',
            );
          }

          // An orange question is retrieval of a list the passage actually
          // contains. Options that never co-occur as a series were reverse-
          // engineered out of prose that has no list — and the fix for that is in
          // the passage, not in the question.
          const options = answers
            .map((a) => normalizeText(a))
            .filter(
              (norm) => isSingleWord(norm) && containsPhrase(ctx.passage, norm),
            );
          const distinct = [...new Set(options)];
          if (
            distinct.length < ORANGE_MIN_ANSWERS ||
            distinct.length !== answers.length
          ) {
            break;
          }

          // One question, one WHOLE list. A run that covers every accepted answer
          // but stops before the series does means the passage lists an item the
          // question won't accept — so a speller who names it, having read exactly
          // what they were told to read, is marked wrong.
          const key = [...distinct].sort().join("|");
          let partial = null;
          let complete = false;
          for (const tokens of ctx.sentences) {
            const run = findListRun(tokens, distinct);
            if (!run) continue;
            // The series has to end where the accepted answers do — checked at
            // the run's last item, wherever the conjunctions inside it fell, so
            // "cats and dogs" is caught in front of "and rabbits".
            const nextItem = nextListItemAfter(tokens, run[run.length - 1].at);
            if (!nextItem) {
              complete = true;
              break;
            }
            partial ??= nextItem;
          }

          if (complete) break;
          if (partial) {
            error(
              "E_ORANGE_PARTIAL_LIST",
              `${questionId}:${key}`,
              ctx.number,
              `${ctx.label}: the passage's list runs on past the accepted answers ` +
                `${answers.map((a) => `"${a}"`).join(", ")} — it goes on to "${partial}". The accepted answers ` +
                "must be EVERY item of the one list the question blanks out, or a speller who names the item you " +
                "left out is marked wrong for reading the passage properly. Accept the remaining item(s), or take " +
                "them out of the list in the prose.",
            );
          } else {
            error(
              "E_ORANGE_NOT_A_LIST",
              `${questionId}:${key}`,
              ctx.number,
              `${ctx.label}: the accepted answers ${answers.map((a) => `"${a}"`).join(", ")} appear in that ` +
                "section's passage, but not together as one list. An orange question retrieves a list the prose " +
                'already states — write it in as an explicit series ("The blast sent out red-hot rock, choking ' +
                'gas, and clouds of ash"), then quote that sentence with the list blanked out. Do not build the ' +
                'question out of words that are not a series: "the Pacific Ocean" is one noun phrase, not PACIFIC ' +
                "and OCEAN. When an orange question is weak the fix is almost always to rewrite the passage, not " +
                "the question.",
            );
          }
          break;
        }

        case "number": {
          // A number question with no steps is the fill-in-the-blank one, so its
          // value has to be sitting in the passage. One with steps is the word
          // problem: its answer is computed, not quoted.
          if (hasSteps(block)) break;
          for (const answer of answers) {
            if (containsPhrase(ctx.passage, normalizeText(answer))) continue;
            error(
              "E_GROUNDING_NUMBER_FILL",
              `${questionId}:${normalizeText(answer)}`,
              ctx.number,
              `${ctx.label}: the answer ${answer} does not appear in that section's passage. ` +
                "A fill-in-the-blank purple question asks for a number the passage states. If this is meant to be " +
                "the word problem instead, add its worked solution to `steps`.",
            );
          }
          break;
        }

        case "background": {
          const backgroundText =
            typeof block.background === "string" ? block.background.trim() : "";
          if (!backgroundText) {
            error(
              "E_BACKGROUND_NO_CONTEXT",
              questionId,
              ctx.number,
              `${where}: this blue (background) question has no \`background\` field. ` +
                "Add the prior-knowledge context the speller is expected to bring to it.",
            );
          }
          for (const answer of answers) {
            if (!containsPhrase(ctx.passage, normalizeText(answer))) continue;
            error(
              "E_BACKGROUND_IN_TEXT",
              `${questionId}:${normalizeText(answer)}`,
              ctx.number,
              `${ctx.label}: the background answer "${answer}" appears in that section's passage. ` +
                "A blue question must need knowledge from outside the lesson — that is the entire point of the type. " +
                "Ask for something the passage deliberately does not say, or make this a green (single) question.",
            );
          }
          break;
        }

        case "open": {
          if (RETIRED_STEM.test(block.prompt || "")) {
            error(
              "E_RETIRED_STEM",
              questionId,
              ctx.number,
              `${where}: the stem "…one word that comes to mind…" is retired — it was overused to the point ` +
                'of becoming a tic. For a tight open, name an everyday category instead: "Name a color of a crayon", ' +
                '"Name something found in a hospital", "Name something that uses electricity".',
            );
          }
          break;
        }

        default:
          break;
      }
    });

    // --- One prompt must not hand over another question's answer -----------
    //
    // Green answers and orange options are the words the speller is meant to
    // retrieve. Writing one into a different question's prompt in the same
    // section lets them copy it across instead: a green question answered
    // BRITAIN, followed by a fill-in reading "…cats reached Britain around the
    // year ___", gives the green answer away. The fix is a rephrasing — "the
    // British Isles".
    //
    // Only recall answers count, which is why this reads green and orange and
    // nothing else. A prompt may freely name a topic word whose own question
    // wants a number back — "more than ___ mummies at Bubastis" does not help
    // anyone produce BUBASTIS — and circumlocuting every such mention would make
    // prompts clumsy for no gain.
    const recall = [];
    ctx.questions.forEach((block, qi) => {
      const type = block?.questionType;
      if (type !== "single" && type !== "multiple") return;
      for (const answer of answersOf(block)) {
        recall.push({
          answer,
          norm: normalizeText(answer),
          owner: block?.id || `${ctx.id}#q${qi}`,
          number: qi + 1,
        });
      }
    });
    ctx.questions.forEach((block, qi) => {
      const questionId = block?.id || `${ctx.id}#q${qi}`;
      const promptNorm = normalizeText(block?.prompt || "");
      if (!promptNorm) return;
      // A prompt carrying its own orange answers is E_ORANGE_ANSWER_IN_PROMPT's
      // business, so the owning question is skipped here rather than reported
      // twice under two codes.
      const leaked = [];
      for (const entry of recall) {
        if (entry.owner === questionId) continue;
        if (!containsPhrase(promptNorm, entry.norm)) continue;
        if (leaked.some((seen) => seen.norm === entry.norm)) continue;
        leaked.push(entry);
      }
      if (!leaked.length) return;
      const named = leaked
        .map(
          (entry) =>
            `"${entry.answer}" (the answer to question ${entry.number})`,
        )
        .join(", ");
      const key = `${questionId}:${leaked
        .map((entry) => entry.norm)
        .sort()
        .join("|")}`;
      // A pink prompt is the one place the leak is not always a defect. An
      // extended open exists to make the speller talk about the section's
      // subject, and the section's subject is usually a green answer — "In your
      // own words, explain how a delta forms" cannot avoid DELTA without
      // becoming vague. Worth flagging, never worth blocking.
      if (block.questionType === "open") {
        warn(
          "W_ANSWER_REVEALED_OPEN",
          key,
          ctx.number,
          `${ctx.label}, question ${qi + 1}: this pink prompt names ${named}, so the speller can read that ` +
            "answer off it. Fine when the open question genuinely has to name the section's subject; worth " +
            "rewording if it doesn't.",
        );
        return;
      }
      error(
        "E_ANSWER_REVEALED_CROSS",
        key,
        ctx.number,
        `${ctx.label}, question ${qi + 1}: the prompt names ${named}. ` +
          "A prompt must not contain a word another question in the same section expects the speller to " +
          "retrieve — they can copy it across instead of recalling it. Rephrase around it: a green answer of " +
          'BRITAIN followed by a prompt reading "…cats reached Britain around the year ___" is fixed by ' +
          'writing "the British Isles".',
      );
    });

    // --- Section shape -----------------------------------------------------

    if (!ctx.questions.length) {
      warn(
        "W_NO_QUESTION",
        ctx.id,
        ctx.number,
        `${ctx.label} has no question. Each section should end with its own questions about its own content — ` +
          "add them, or move them out of any separate quiz section at the end.",
      );
    } else {
      const shape = ctx.questions.map((q) => q.questionType);
      if (shape.join(",") !== QUESTION_ORDER.join(",")) {
        warn(
          "W_QUESTION_SHAPE",
          ctx.id,
          ctx.number,
          `${ctx.label} has ${shape.length} question(s) in the order ${shape.join(", ")}. ` +
            `The default is ${QUESTION_ORDER.length}, in this order: ${QUESTION_ORDER.join(", ")} ` +
            `(3 green, 2 purple, 2 orange, 1 blue, then ${TIGHT_OPENS} tight opens and ${EXTENDED_OPENS} extended opens).`,
        );
      }

      const opens = ctx.questions.filter((q) => q.questionType === "open");
      if (opens.length === TIGHT_OPENS + EXTENDED_OPENS) {
        const kinds = opens.map((q) => openKind(q.prompt));
        const tightOk = kinds.slice(0, TIGHT_OPENS).every((k) => k === "tight");
        const extendedOk = kinds
          .slice(TIGHT_OPENS)
          .every((k) => k === "extended");
        if (!tightOk || !extendedOk) {
          warn(
            "W_OPEN_SPLIT",
            ctx.id,
            ctx.number,
            `${ctx.label}: the ${opens.length} pink questions don't read as ${TIGHT_OPENS} tight opens followed by ` +
              `${EXTENDED_OPENS} extended opens. The first ${TIGHT_OPENS} should be easy one-word recall from the ` +
              'speller\'s own world ("Name something found in a hospital"); the last ' +
              `${EXTENDED_OPENS} should invite a full sentence ("In your own words, explain…", "…Defend your answer.").`,
          );
        }
      }

      const numbers = ctx.questions.filter((q) => q.questionType === "number");
      if (numbers.length >= 2 && !numbers.some(hasSteps)) {
        warn(
          "W_NUMBER_NO_STEPS",
          ctx.id,
          ctx.number,
          `${ctx.label}: no purple question carries \`steps\`. The second one is the word problem — put its ` +
            "worked solution in the `steps` array, one step per element, rather than in the prompt or nowhere at all.",
        );
      }
    }

    if (ctx.spelling.length !== SPELLING_WORDS_PER_SECTION) {
      warn(
        "W_SPELLING_COUNT",
        ctx.id,
        ctx.number,
        `${ctx.label} has ${ctx.spelling.length} spelling word(s). The default is exactly ` +
          `${SPELLING_WORDS_PER_SECTION} per section.`,
      );
    }

    for (const word of ctx.spelling) {
      const letters = letterCount(word);
      if (letters < SPELLING_MIN_LETTERS || letters > SPELLING_MAX_LETTERS) {
        error(
          "E_SPELLING_LENGTH",
          `${ctx.id}:${normalizeText(word)}`,
          ctx.number,
          `${ctx.label}: the spelling word "${word}" is ${letters} letters. Spelling words must be ` +
            `${SPELLING_MIN_LETTERS}-${SPELLING_MAX_LETTERS} letters.`,
        );
      }
      if (ctx.caps.has(normalizeText(word))) {
        warn(
          "W_SPELLING_IN_CAPS",
          `${ctx.id}:${normalizeText(word)}`,
          ctx.number,
          `${ctx.label}: the spelling word "${word}" is also ALL-CAPS learning vocabulary in that section's ` +
            "passage. The two lists are meant to be separate — reusing the passage's vocabulary as a warm-up word " +
            "is redundant and too obvious. Pick a different word on the same theme.",
        );
      }
    }
  }

  // --- Lesson-wide collisions ----------------------------------------------

  // Spelling words: unique across the lesson, and never hiding inside an answer
  // (PRISON inside "the prisoner's dilemma"), which is why this one is a raw
  // substring test rather than a whole-word one.
  const seenSpelling = new Map();
  for (const ctx of context) {
    for (const word of ctx.spelling) {
      const norm = normalizeText(word);
      const first = seenSpelling.get(norm);
      if (first && first.ctx.number !== ctx.number) {
        error(
          "E_SPELLING_DUPLICATE",
          `${pairKey(first.ctx.id, ctx.id)}|${norm}`,
          ctx.number,
          `The spelling word "${word}" is used in both section ${first.ctx.number} and section ${ctx.number}. ` +
            "Each section needs its own four words.",
        );
      } else if (first) {
        error(
          "E_SPELLING_DUPLICATE",
          `${ctx.id}|${norm}`,
          ctx.number,
          `${ctx.label} lists the spelling word "${word}" twice.`,
        );
      } else {
        seenSpelling.set(norm, { ctx, word });
      }
    }
  }

  for (const [norm, { ctx, word }] of seenSpelling) {
    for (const answer of allAnswers) {
      if (!answer.norm.includes(norm)) continue;
      error(
        "E_SPELLING_COLLISION",
        `${pairKey(ctx.id, answer.questionId)}|${norm}|${answer.norm}`,
        ctx.number,
        `Section ${ctx.number}'s spelling word "${word}" appears inside the answer "${answer.text}" ` +
          `(${answer.where}). A spelling word must not turn up in any answer anywhere in the lesson — the ` +
          "warm-up would give the answer away. Change one or the other.",
      );
    }
  }

  // One answer word, one question. Whole answers are the unit, so "A SHIELD
  // VOLCANO" and "A STRATOVOLCANO" coexist happily; what this catches is the same
  // standalone word answering twice (GAS in three sections' orange lists), and a
  // one-word answer reappearing inside a longer one.
  const reusable = allAnswers.filter(
    (a) => a.questionType === "single" || a.questionType === "multiple",
  );
  const byAnswer = new Map();
  for (const answer of reusable) {
    if (!answer.norm) continue;
    const seen = byAnswer.get(answer.norm);
    if (!seen) {
      byAnswer.set(answer.norm, answer);
      continue;
    }
    if (seen.questionId === answer.questionId) continue;
    error(
      "E_ANSWER_WORD_REUSED",
      `${pairKey(seen.questionId, answer.questionId)}|${answer.norm}`,
      answer.section,
      `The answer "${answer.text}" is used by more than one question (${seen.where} and ${answer.where}). ` +
        "Each answer word belongs to exactly one question, anywhere in the lesson and at any length — give this " +
        "question its own distinct word.",
    );
  }

  for (const [norm, answer] of byAnswer) {
    if (!isSingleWord(norm)) continue;
    for (const other of reusable) {
      if (other.questionId === answer.questionId) continue;
      if (isSingleWord(other.norm)) continue;
      if (!wordsOf(other.norm).includes(norm)) continue;
      error(
        "E_ANSWER_WORD_REUSED",
        `${pairKey(answer.questionId, other.questionId)}|${norm}|${other.norm}`,
        answer.section,
        `The one-word answer "${answer.text}" (${answer.where}) also appears inside the answer "${other.text}" ` +
          `(${other.where}). A word that answers one question should not turn up in another question's answer.`,
      );
    }
  }

  // Numeric answers are distinct across the lesson, so no two purple questions
  // ever resolve to the same figure.
  const seenNumbers = new Map();
  for (const ctx of context) {
    ctx.questions.forEach((block, qi) => {
      if (block.questionType !== "number") return;
      const questionId = block?.id || `${ctx.id}#q${qi}`;
      for (const answer of answersOf(block)) {
        const key = numericKey(answer);
        const first = seenNumbers.get(key);
        if (first) {
          // Both purple questions in one section can land on the same figure, and
          // "section 1 and section 1" would leave the author hunting.
          const place =
            first.ctx.number === ctx.number
              ? `both in section ${ctx.number}`
              : `section ${first.ctx.number} and section ${ctx.number}`;
          error(
            "E_NUMBER_DUPLICATE",
            `${pairKey(first.questionId, questionId)}|${key}`,
            ctx.number,
            `The number ${answer} answers two different questions (${place}). ` +
              "Every numeric answer in a lesson should be distinct — rework one of the problems so it lands on a " +
              "different figure.",
          );
        } else {
          seenNumbers.set(key, { ctx, questionId });
        }
      }
    });
  }

  if (sections.length !== SECTION_COUNT) {
    warn(
      "W_SECTION_COUNT",
      String(sections.length),
      null,
      `This lesson has ${sections.length} section(s); the default is ${SECTION_COUNT}. ` +
        "That is fine if the user asked for a different length — otherwise add or remove sections.",
    );
  }

  return {
    errors: findings.filter((f) => f.level === "error"),
    warnings: findings.filter((f) => f.level === "warning"),
  };
}

/**
 * Checks that can only be made against the caller's raw input, because buildBlock
 * drops the offending fields on the way into the doc — an `open` question that
 * arrives carrying an answer would otherwise be silently stripped, leaving the
 * model believing the lesson holds an answer it does not.
 *
 * @param {Array<{ block: any, where: string, section: number|null }>} entries
 * @returns {Finding[]}
 */
export function validateInput(entries) {
  const findings = [];
  for (const { block, where, section } of entries) {
    if (block?.type !== "question" || block.questionType !== "open") continue;
    const stray = ["answer", "answers", "exampleAnswer"].filter(
      (field) => block[field] != null && block[field] !== "",
    );
    if (!stray.length) continue;
    findings.push({
      level: "error",
      code: "E_OPEN_HAS_ANSWER",
      key: `E_OPEN_HAS_ANSWER:${where}`,
      section: section ?? null,
      message:
        `${where}: this open (pink) question carries ${stray.map((f) => `\`${f}\``).join(", ")}. ` +
        "Open questions have no answer of any kind — just the `prompt`. Remove the field, or change the question " +
        "type to one that does take an answer.",
    });
  }
  return findings;
}

/**
 * Flatten lesson input into the entries validateInput wants.
 * @param {Array<{ blocks?: any[] }>} sections
 */
export function inputBlocksFromSections(sections) {
  return (Array.isArray(sections) ? sections : []).flatMap((section, i) =>
    (Array.isArray(section?.blocks) ? section.blocks : []).map((block, j) => ({
      block,
      where: `Section ${i + 1}, block ${j + 1}`,
      section: i + 1,
    })),
  );
}

/**
 * The same, for the blocks carried by patch operations.
 * @param {any[]} operations
 */
export function inputBlocksFromOperations(operations) {
  return (Array.isArray(operations) ? operations : []).flatMap((op, i) => {
    const where = `Operation ${i + 1} (${op?.op || "?"})`;
    const blocks = [];
    if (op?.block) blocks.push({ block: op.block, where, section: null });
    if (Array.isArray(op?.blocks)) {
      op.blocks.forEach((block, j) =>
        blocks.push({
          block,
          where: `${where}, block ${j + 1}`,
          section: null,
        }),
      );
    }
    return blocks;
  });
}

/**
 * Render findings as the numbered list a tool result carries back. Capped, because
 * a badly-shaped lesson can produce hundreds and the first handful are the ones
 * worth reading.
 * @param {Finding[]} findings
 * @param {number} [limit]
 */
export function formatFindings(findings, limit = 25) {
  const shown = findings.slice(0, limit);
  const lines = shown.map((f, i) => `${i + 1}. [${f.code}] ${f.message}`);
  if (findings.length > shown.length) {
    lines.push(
      `…and ${findings.length - shown.length} more of the same kind. Fix these first and resubmit to see the rest.`,
    );
  }
  return lines.join("\n");
}

/**
 * The message a rejected write returns. Names the count, lists the defects, and
 * points at the escape hatch, so the model can correct and resubmit without
 * having read the standard.
 * @param {Finding[]} errors
 */
export function validationErrorMessage(errors) {
  return (
    `This lesson does not meet the authoring standard, so nothing was saved. ` +
    `${errors.length} problem${errors.length === 1 ? "" : "s"} to fix:\n\n` +
    `${formatFindings(errors)}\n\n` +
    "Correct these and call the tool again. If the user genuinely wants a lesson the standard forbids, " +
    'pass "skipValidation": true to save it as-is.'
  );
}

/**
 * Findings the caller is responsible for: everything in `after` that wasn't
 * already true of `before`. Used by patch_lesson so a one-line tweak to a lesson
 * written elsewhere (in the web editor, or before these rules existed) isn't
 * blocked by defects the patch didn't introduce. Keyed on the defect's identity
 * rather than its message, so inserting a section doesn't make every later
 * finding look new.
 * @param {Finding[]} before
 * @param {Finding[]} after
 */
export function newFindings(before, after) {
  const existing = new Set(before.map((f) => f.key));
  return after.filter((f) => !existing.has(f.key));
}
