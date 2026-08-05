// Lesson authoring standards, fed to the connecting AI assistant so it produces
// well-shaped lessons by default without the user re-explaining the rules every
// session. Developed iteratively while authoring S2C (Spelling to Communicate)
// lessons for a non-speaking or minimally-speaking speller who answers by
// pointing to letters on a letterboard — which is why answers must be short,
// unambiguous, and findable in the text.
//
// Sent to clients as the server's `instructions` (see worker.js / stdio.js) and
// also embedded directly in create_lesson's tool description (tools.js), since
// not every MCP client surfaces server-level instructions to the model (notably
// claude.ai's connector UI doesn't). Other tools that share the same authoring
// standard (e.g. create_lesson_file) point to create_lesson's description rather
// than repeating this text. This file is the canonical copy of the standard —
// when it changes, update the question counts echoed in tools.js's descriptions
// and in apps/docs/docs/mcp-server/tools.md to match.
export const LESSON_STANDARDS = `LESSON AUTHORING STANDARDS (defaults — honour the user if they ask for something different)

SHAPE: 6 sections. Each section = [image?] + 2 text paragraphs + 4 spelling words + 15 questions,
in that order. Questions belong to their own section; never collect them into a separate quiz
section at the end.

PASSAGES: 2 short paragraphs per section (~60-110 words each). ALL-CAPS words are the harder,
less-common learning vocabulary — a SEPARATE set of words from the spelling list (§ below), never
overlapping. Make sure each passage contains a few concrete single-word nouns — materials, tools,
places, parts — that the orange questions can ask the speller to name; there is no need to plant
parenthetical synonyms in the prose any more. Any fact a math question needs must be stated in the
passage first. Describe other cultures with curiosity, never as strange ("Fascinating Countries",
not "Unusual Countries") — this is a hard rule. Handle mental illness, war, death, and disability
factually and with dignity, without euphemism or tragedy-framing. Verify anything time-sensitive
(records, prices, "world's largest X") before writing it down.

SPELLING: exactly 4 words per section, each 6-9 letters. Thematically related to the topic but
NOT drawn from the passage's ALL-CAPS vocabulary (reusing it is redundant and too obvious). A
spelling word must never appear as, or as a substring inside, any answer anywhere in the lesson
(e.g. PRISON inside "the prisoner's dilemma" is a conflict). No spelling word repeats across
sections.

QUESTIONS per section, always in this exact order (15 total):
  1-3   single     (green)  — 3 questions; each answer appears VERBATIM in this section's passage
  4     number     (purple) — fill-in-the-blank; the number appears in the passage
  5     number     (purple) — a word problem (see MATH below)
  6-7   multiple   (orange) — 2 questions, each with 2-4 accepted answers. Every accepted answer is
                               a SINGLE WORD appearing verbatim in this section's text. These are
                               simple retrieval, not analysis: ask the speller to name concrete
                               nouns lifted straight from the prose ("Name a material used to build
                               the dam" -> CONCRETE, STEEL, ROCK; "Name a machine mentioned in the
                               passage" -> CRANE, TRUCK, DRILL). NOT synonym questions ("give a
                               synonym for X"), and NOT evidence/list answers phrased as long
                               quotations — both ask the speller to hold too much in mind and to
                               spell long strings on a letterboard.
  8     background (blue)   — prior knowledge the passage deliberately does NOT contain; always
                               include the "background" field with that context
  9-12  open       (pink)   — 4 TIGHT OPENS: open-ended, with no single correct answer, but they
                               must elicit an EASY one-word answer from the speller's own world,
                               never from the passage. Two properties both matter: (a) the prompt
                               names an everyday category broad enough that almost any speller can
                               answer instantly, and (b) the load is LIGHT — the answer should come
                               the moment they read the prompt, with no reasoning, no searching the
                               lesson, nothing abstract or philosophical. Good: "Name a color of a
                               crayon", "Name something found in a hospital", "Name something that
                               uses electricity", "Name a recreational activity to do on a lake".
                               Too hard, do NOT write these: "What is one word for a puzzle that is
                               very hard to solve?" (abstract), "Think of a word that means
                               never-ending" (a vocabulary puzzle), "Name something that sounds
                               impossible but is real" (philosophical). Relate the CATEGORY to the
                               section's theme — a dam lesson invites "Name something that floats" —
                               but keep the ANSWER in everyday life; the link is thematic and light
                               and must never turn the question into a comprehension check. Vary
                               the stems: "Name a...", "Name something that...", "Name something
                               found in...", "Name a kind of...", "Name a place where...", "Name an
                               animal that...". NEVER use "Give one word that comes to mind when
                               you..." (retired — overused to the point of becoming a tic).
  13-15 open       (pink)   — 3 EXTENDED OPENS: full-sentence responses, e.g. "In your own words,
                               explain..." / "...Defend your answer." / "...Explain your
                               thinking." The very last question of the whole lesson should look
                               back across all sections, e.g. "Of the six parts of this lesson,
                               which idea did you find most astonishing? Defend your answer."
  "open" questions carry no answer or example-answer field at all — just the "prompt".

MATH (number questions): scale difficulty to the audience — for a 14+ speller, "two more than
five" is not acceptable. Use real mathematics: percentage increase and percentages to 1-2 decimal
places, powers of ten and scientific notation, combinatorics (nCr, permutations, single-
elimination counting), compound/independent probability, prime factorisation, modular arithmetic,
inequalities. Draw the problem from THIS section's own content, so solving it produces an insight
rather than sitting beside the lesson. ALWAYS put the worked solution in the "steps" array, one
step per element, in order — never bake it into the prompt string, never give a bare answer. Good
steps show the set-up, flag the common error where one exists (e.g. "divide by the ORIGINAL value,
not the new one"), break hard arithmetic into pieces, and verify where verification is cheap. The
plain fill-in-the-blank number question (item 4 above) doesn't need steps.

IMAGES: source only from Wikimedia Commons via search_images (freely licensed: CC / CC0 / public
domain); keep the attribution in the caption — if overriding it, append the original attribution
rather than replacing it. An image should go FIRST in its section, above both paragraphs — but
add_image's default placement is the END of the section's prose (just before any question
blocks), so to get the image first pass "index": 0 (with "sectionId"/"sectionIndex") explicitly;
don't rely on the default when the image goes with a section's opening. Prefer images that do
double duty (reinforce a green answer AND illustrate) or diagrams that carry an argument, over
decorative photos. Check the image doesn't contradict the text (e.g. a shift direction, an
orientation). Source files roughly 1000-1900px wide upload reliably; much larger files can fail
with a Cloudflare "Worker exceeded resource limits" error — pick a smaller source rather than
retrying the same large one.

BRANDING: none. Do not add any brand name, byline, or footer to a generated lesson unless the
user explicitly supplies one.

VALIDATE BEFORE SAVING (each has caught a real defect):
- every green/orange/purple-fill-in answer appears literally in its own section's passage
- every blue answer does NOT appear in its own section's passage
- every fact a math problem depends on appears in the passage
- spelling words are 6-9 letters, unique across the lesson, and never a substring of any answer
- no ALL-CAPS vocabulary word is also a spelling word
- no answer word of 6+ letters repeats across sections (a few topic words may legitimately recur)
- all numeric answers across the whole lesson are distinct
- each section has exactly 3 single + 2 number + 2 multiple + 1 background + 4 tight-open +
  3 extended-open = 15 questions, in the order given above
- every orange accepted answer is a single word, with 2-4 answers per orange question
- no pink question uses the retired "comes to mind" stem
- tight opens are easy everyday recall — not abstract, not vocabulary puzzles, not
  lesson-dependent`;
