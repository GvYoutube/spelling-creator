// Validation tests. The load-bearing one is the first: a lesson written exactly
// to the standard must produce nothing at all. Every check here rejects real
// lessons on a real write path, so a false positive is worse than a missed
// defect — it blocks an author who did nothing wrong.
//
// The rest mutate that clean lesson one rule at a time, which keeps each case
// honest about what it proves: the fixture is known-good, so any finding is
// attributable to the mutation.

import assert from "node:assert/strict";
import test from "node:test";

import { buildDoc } from "../src/doc.js";
import { applyPatch } from "../src/patch.js";
import {
  formatFindings,
  inputBlocksFromOperations,
  inputBlocksFromSections,
  newFindings,
  normalizeText,
  validateInput,
  validateLesson,
  validationErrorMessage,
} from "../src/validate.js";

// A section written to the standard: 2 paragraphs holding every answer the
// questions ask for, 4 spelling words that appear in no answer, and 15 questions
// in the fixed order.
//
// Each section's prose carries the TWO explicit "X, Y, and Z" lists its orange
// questions retrieve, because that is the rule — an orange question can only ask
// for a list the passage already states, so a fixture without planted lists would
// not be a lesson written to the standard at all.
const SECTIONS = [
  {
    name: "Rivers",
    paragraphs: [
      "A river begins as a TRICKLE high in the hills. Sort what the water carries and it comes out as " +
        "boulder, cobble, and silt, each size dropped where the flow can no longer lift it. The stream " +
        "cuts a channel through soft ground, shifting the gravel in its bed, and that channel deepens a " +
        "little more each year.",
      "Near the sea the river slows and spreads into a delta. Along the bank stand willow, alder, and " +
        "hazel, their roots holding the mud in place. The delta here is 7 kilometres wide, and it is " +
        "still growing as the SEDIMENT settles.",
    ],
    spelling: ["torrent", "meander", "estuary", "tributary"],
    greens: ["gravel", "channel", "delta"],
    fill: 7,
    problem: { answer: 350, steps: ["50 x 7 = 350"] },
    oranges: [
      ["boulder", "cobble", "silt"],
      ["willow", "alder", "hazel"],
    ],
    background: "ocean",
  },
  {
    name: "Mountains",
    paragraphs: [
      "A mountain ridge is built and then taken apart. Frost prises the rock apart — granite, schist, " +
        "and slate all split the same way — and the pieces slide down until the slope below is buried " +
        "in them. The ALPINE air is thin enough that climbers move slowly.",
      "Between two peaks sits a saddle, the low crossing point every path uses. Higher up, the summit " +
        "holds snow for 4 months of the year. Above the treeline the marmot, the ibex, and the chough " +
        "make a living where lichen is the only crop that will GERMINATE.",
    ],
    spelling: ["crevasse", "altitude", "plateau", "avalanche"],
    greens: ["ridge", "saddle", "summit"],
    fill: 4,
    problem: { answer: 128, steps: ["2 to the power of 7 = 128"] },
    oranges: [
      ["granite", "schist", "slate"],
      ["marmot", "ibex", "chough"],
    ],
    background: "compass",
  },
  {
    name: "Deserts",
    paragraphs: [
      "A dune moves. Wind lifts the grains up the gentle side and drops them down the steep one, so the " +
        "whole ridge of sand walks slowly downwind. Underneath it lie beds of sandstone, gypsum, and " +
        "shale, the middle one soft enough to scratch with a fingernail.",
      "Where water reaches the surface an oasis appears, and everything living crowds around it. A " +
        "cactus stores what it can. The scorpion, the gecko, and the jerboa wait out the heat below " +
        "ground, on sand that is 12 degrees hotter than the air above it. The land looks ARID but it " +
        "is not empty.",
    ],
    spelling: ["aquifer", "drought", "sirocco", "erosion"],
    greens: ["dune", "oasis", "cactus"],
    fill: 12,
    problem: { answer: 96, steps: ["12 x 8 = 96"] },
    oranges: [
      ["scorpion", "gecko", "jerboa"],
      ["sandstone", "gypsum", "shale"],
    ],
    background: "camel",
  },
  {
    name: "Forests",
    paragraphs: [
      "The canopy takes the light first, and everything below lives on what gets past it. A maple, a " +
        "cedar, and a birch can stand side by side and reach it by different routes. Rain runs down the " +
        "bark in channels worn by a century of it.",
      "On the floor, a fungus breaks down what falls. Dead wood is worked over by beetle, woodlouse, " +
        "and millipede, with moss holding the water above them like a sponge. A single fallen trunk can " +
        "feed the soil for 30 years, which is why a cleared forest is so hard to REPLICATE.",
    ],
    spelling: ["seedling", "thicket", "humidity", "sapwood"],
    greens: ["canopy", "fungus", "bark"],
    fill: 30,
    problem: { answer: 720, steps: ["30 x 24 = 720"] },
    oranges: [
      ["beetle", "woodlouse", "millipede"],
      ["maple", "cedar", "birch"],
    ],
    background: "chlorophyll",
  },
  {
    name: "Oceans",
    paragraphs: [
      "A current is a river inside the sea, and it does not mix with the water it runs through. Plankton " +
        "drifts wherever it is carried, and everything larger follows. The dolphin, the tuna, and the " +
        "gannet all hunt along its edge, where the food is densest.",
      "Closer in, a reef builds itself out of its own skeletons. Whatever lives on bare rock has to hold " +
        "on to it: barnacle, kelp, and urchin each manage it differently. The shelf here runs out to " +
        "200 metres before the floor drops into the PELAGIC dark.",
    ],
    spelling: ["seabed", "trawler", "buoyancy", "salinity"],
    greens: ["current", "plankton", "reef"],
    fill: 200,
    problem: { answer: 1500, steps: ["200 x 7.5 = 1500"] },
    oranges: [
      ["barnacle", "kelp", "urchin"],
      ["dolphin", "tuna", "gannet"],
    ],
    background: "tsunami",
  },
  {
    name: "Volcanoes",
    paragraphs: [
      "Magma is rock that has given up being solid. Where it reaches the surface it runs out as " +
        "INCANDESCENT sheets, and what cools out of it can be basalt, pumice, or obsidian, depending on " +
        "how much gas it was carrying.",
      "A volcano wears its history on the surface: vent, fissure, and caldera each mark a different way " +
        "the mountain has let go. A crater sits at the top of the youngest one. Ash travels furthest of " +
        "all — a single blast can put it 900 kilometres downwind, which is why the record of one is so " +
        "hard to MISREAD.",
    ],
    spelling: ["eruption", "volcanic", "tectonic", "sulphur"],
    greens: ["magma", "crater", "ash"],
    fill: 900,
    problem: { answer: 2700, steps: ["900 x 3 = 2700"] },
    oranges: [
      ["basalt", "pumice", "obsidian"],
      ["vent", "fissure", "caldera"],
    ],
    background: "seismograph",
  },
];

const TIGHT_OPENS = [
  "Name something found in a kitchen.",
  "Name a color of a crayon.",
  "Name something that uses electricity.",
  "Name an animal you might see at a zoo.",
];

const EXTENDED_OPENS = [
  "In your own words, explain what is happening here.",
  "Which part surprised you most? Defend your answer.",
  "Would you want to see this in person? Explain your thinking.",
];

function sectionInput(spec) {
  return {
    name: spec.name,
    blocks: [
      ...spec.paragraphs.map((text) => ({ type: "text", text })),
      { type: "spelling", words: spec.spelling },
      ...spec.greens.map((answer, i) => ({
        type: "question",
        questionType: "single",
        prompt: `Green ${i + 1}?`,
        answer,
      })),
      {
        type: "question",
        questionType: "number",
        prompt: "Fill in the blank.",
        answer: spec.fill,
      },
      {
        type: "question",
        questionType: "number",
        prompt: "Work it out.",
        answer: spec.problem.answer,
        steps: spec.problem.steps,
      },
      // The prompt quotes the passage's sentence with the list blanked out, so
      // the speller recalls it — an orange prompt holding its own answers is a
      // defect in its own right.
      ...spec.oranges.map((answers, i) => ({
        type: "question",
        questionType: "multiple",
        prompt: `The passage lists three of them — ______. Name one (${i + 1}).`,
        answers,
      })),
      {
        type: "question",
        questionType: "background",
        prompt: "What do you already know?",
        background: "Prior knowledge the passage does not supply.",
        answer: spec.background,
      },
      ...TIGHT_OPENS.map((prompt) => ({
        type: "question",
        questionType: "open",
        prompt,
      })),
      ...EXTENDED_OPENS.map((prompt) => ({
        type: "question",
        questionType: "open",
        prompt,
      })),
    ],
  };
}

// A fresh, independently mutable copy every time.
function lessonInput() {
  return {
    title: "Landscapes",
    sections: structuredClone(SECTIONS).map(sectionInput),
  };
}

// Validate a lesson input, optionally after mutating it.
function check(mutate) {
  const input = lessonInput();
  if (mutate) mutate(input);
  return validateLesson(buildDoc(input));
}

function codes(findings) {
  return findings.map((f) => f.code);
}

// The nth question block of a section, counting questions only.
function question(input, sectionIndex, questionIndex) {
  return input.sections[sectionIndex].blocks.filter(
    (b) => b.type === "question",
  )[questionIndex];
}

test("a lesson written to the standard produces no errors and no warnings", () => {
  const { errors, warnings } = check();
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  );
  assert.deepEqual(
    warnings.map((w) => w.message),
    [],
  );
});

test("normalizeText survives thousands separators, decimals and punctuation", () => {
  assert.equal(normalizeText("Fuji is 3,776 m tall."), "FUJI IS 3776 M TALL");
  assert.equal(normalizeText("3776"), "3776");
  assert.equal(
    normalizeText("It rose 112.5 percent."),
    "IT ROSE 112.5 PERCENT",
  );
  assert.equal(
    normalizeText("the prisoner's dilemma"),
    "THE PRISONER S DILEMMA",
  );
  assert.equal(normalizeText("  MAGMA.  "), "MAGMA");
});

test("a green answer must appear word for word in its own passage", () => {
  const { errors } = check((input) => {
    question(input, 0, 0).answer = "shingle";
  });
  assert.deepEqual(codes(errors), ["E_GROUNDING_SINGLE"]);
  assert.match(errors[0].message, /Section 1 "Rivers"/);
  assert.match(errors[0].message, /"shingle"/);
  assert.equal(errors[0].section, 1);
});

test("a green answer is not satisfied by a word from another section", () => {
  const { errors } = check((input) => {
    question(input, 0, 0).answer = "granite"; // section 2's passage, not section 1's
  });
  // Grounded nowhere in section 1, and it belongs to a section 2 question
  // already — two separate rules, both broken by one edit.
  assert.deepEqual(codes(errors), [
    "E_GROUNDING_SINGLE",
    "E_ANSWER_WORD_REUSED",
  ]);
});

test("whole-word matching: a green answer hiding inside a longer word is not grounded", () => {
  const { errors } = check((input) => {
    // "and" is in the passage; "an" only ever appears inside other words.
    question(input, 0, 0).answer = "an";
  });
  assert.deepEqual(codes(errors), ["E_GROUNDING_SINGLE"]);
});

test("a paraphrased orange answer is rejected with the paraphrase message", () => {
  const { errors } = check((input) => {
    question(input, 5, 5).answers = ["molten", "pumice"]; // text says INCANDESCENT
  });
  assert.deepEqual(codes(errors), ["E_ORANGE_PARAPHRASED"]);
  assert.match(errors[0].message, /do not paraphrase/i);
  assert.match(errors[0].message, /background question/i);
});

test("a multi-word orange answer that isn't in the passage warns and errors separately", () => {
  const { errors, warnings } = check((input) => {
    question(input, 0, 5).answers = ["moving with the seasons", "silt"];
  });
  assert.deepEqual(codes(errors), ["E_GROUNDING_MULTIPLE"]);
  assert.match(errors[0].message, /Match the passage's own wording/);
  assert.deepEqual(codes(warnings), ["W_ORANGE_MULTIWORD"]);
});

test("an orange prompt that hands over its own answers is rejected", () => {
  const { errors } = check((input) => {
    question(input, 0, 5).prompt =
      "The river carries boulder, cobble, and silt. Name one.";
  });
  assert.deepEqual(codes(errors), ["E_ORANGE_ANSWER_IN_PROMPT"]);
  assert.match(errors[0].message, /"boulder", "cobble", "silt"/);
  assert.match(errors[0].message, /______/);
});

test("orange answers that never appear together as a list are rejected", () => {
  // The canonical fake list: one noun phrase split into two "options". Both
  // words are in the passage, so only the list check can catch it.
  const { errors } = check((input) => {
    input.sections[2].blocks[0].text +=
      " Beyond the last dune lies the Pacific Ocean.";
    question(input, 2, 5).answers = ["pacific", "ocean"];
  });
  assert.deepEqual(codes(errors), ["E_ORANGE_NOT_A_LIST"]);
  assert.match(errors[0].message, /not together as one list/);
  assert.match(errors[0].message, /rewrite the passage/);
});

test("accepting only part of the passage's list is rejected", () => {
  // The speller is told to name one item listed. If the passage lists three and
  // the question accepts two, naming the third — having read exactly what they
  // were told to read — marks them wrong.
  const { errors } = check((input) => {
    question(input, 0, 5).answers = ["boulder", "cobble"];
  });
  assert.deepEqual(codes(errors), ["E_ORANGE_PARTIAL_LIST"]);
  assert.match(errors[0].message, /runs on past/);
  assert.match(errors[0].message, /"SILT"/);

  // Same defect without the Oxford comma, where the run ends at the conjunction
  // itself rather than at a comma.
  const noOxford = check((input) => {
    input.sections[0].blocks[0].text = input.sections[0].blocks[0].text.replace(
      "boulder, cobble, and silt",
      "boulder, cobble and silt",
    );
    question(input, 0, 5).answers = ["boulder", "cobble"];
  });
  assert.deepEqual(codes(noOxford.errors), ["E_ORANGE_PARTIAL_LIST"]);
});

test("a repeated conjunction doesn't hide the rest of the list", () => {
  // "cats and dogs and rabbits" has a conjunction inside the accepted run as
  // well as after it, so a run that merely crosses one conjunction proves
  // nothing — the series has to end where the answers do.
  const { errors } = check((input) => {
    input.sections[0].blocks[0].text +=
      " The bank held cats and dogs and rabbits.";
    question(input, 0, 5).answers = ["cats", "dogs"];
  });
  assert.deepEqual(codes(errors), ["E_ORANGE_PARTIAL_LIST"]);
  assert.match(errors[0].message, /"RABBITS"/);

  const whole = check((input) => {
    input.sections[0].blocks[0].text +=
      " The bank held cats and dogs and rabbits.";
    question(input, 0, 5).answers = ["cats", "dogs", "rabbits"];
  });
  assert.deepEqual(codes(whole.errors), []);
});

test("a clause coordinated onto a finished list is not another item", () => {
  // The same "and" joins clauses, and a list that ends properly is often
  // followed by one. Reading those as a missing item would reject lessons that
  // are correct, which costs more than the subset this misses.
  const afterFullList = check((input) => {
    input.sections[0].blocks[0].text = input.sections[0].blocks[0].text.replace(
      "boulder, cobble, and silt, each size dropped where the flow can no longer lift it",
      "boulder, cobble, and silt, and the bed shifts a little each winter",
    );
  });
  assert.deepEqual(codes(afterFullList.errors), []);

  const afterPair = check((input) => {
    input.sections[0].blocks[0].text +=
      " The wind carries dust and grit and never lets up.";
    question(input, 0, 5).answers = ["dust", "grit"];
  });
  assert.deepEqual(codes(afterPair.errors), []);
});

test("a complete list is accepted however it closes", () => {
  // A series with no conjunction at all is still a complete list when every item
  // is accepted, and a trailing clause after it is not a fourth item. Both would
  // be false rejections, which cost more than a missed defect.
  const noConjunction = check((input) => {
    input.sections[0].blocks[0].text = input.sections[0].blocks[0].text.replace(
      "boulder, cobble, and silt",
      "boulder, cobble, silt",
    );
  });
  assert.deepEqual(codes(noConjunction.errors), []);

  const trailingClause = check((input) => {
    input.sections[0].blocks[0].text = input.sections[0].blocks[0].text.replace(
      "boulder, cobble, and silt",
      "boulder, cobble, silt, all of it moving",
    );
  });
  assert.deepEqual(codes(trailingClause.errors), []);
});

test("an orange prompt with no blanked-out list warns without blocking", () => {
  // Two orange questions per section, so "Name one." doesn't say which list. It
  // is a warning because a prompt can name its list without a literal blank.
  const { errors, warnings } = check((input) => {
    question(input, 0, 5).prompt = "Name one.";
  });
  assert.deepEqual(codes(errors), []);
  assert.deepEqual(codes(warnings), ["W_ORANGE_NO_BLANK"]);
  assert.match(warnings[0].message, /which list is meant/);
});

test("a list needs its items adjacent, not merely in the same sentence", () => {
  const separated = check((input) => {
    input.sections[2].blocks[0].text +=
      " The survey used a scale called the VEI, the Volcanic Explosivity Index.";
    question(input, 2, 5).answers = ["scale", "index"];
  });
  assert.deepEqual(codes(separated.errors), ["E_ORANGE_NOT_A_LIST"]);

  // And a genuine two-item list joined by "and" alone is fine — a list does not
  // have to carry commas to be one.
  const pair = check((input) => {
    input.sections[2].blocks[0].text +=
      " The wind arrives carrying dust and grit.";
    question(input, 2, 5).answers = ["dust", "grit"];
  });
  assert.deepEqual(codes(pair.errors), []);
});

test("an orange question outside 2-4 answers warns without blocking", () => {
  const { errors, warnings } = check((input) => {
    question(input, 0, 5).answers = ["boulder"];
  });
  assert.deepEqual(codes(errors), []);
  assert.deepEqual(codes(warnings), ["W_ORANGE_ANSWER_COUNT"]);
});

test("the fill-in-the-blank number must be in the passage; the word problem need not be", () => {
  const stray = check((input) => {
    question(input, 0, 3).answer = 41; // no steps, so it is the fill-in-the-blank
  });
  assert.deepEqual(codes(stray.errors), ["E_GROUNDING_NUMBER_FILL"]);

  // The word problem's answer is computed, so it is never expected in the text.
  const computed = check((input) => {
    question(input, 0, 4).answer = 41;
  });
  assert.deepEqual(codes(computed.errors), []);
});

test("thousands separators don't cause a false grounding failure", () => {
  const { errors } = check((input) => {
    input.sections[0].blocks[1].text = input.sections[0].blocks[1].text.replace(
      "7 kilometres",
      "1,450 kilometres",
    );
    question(input, 0, 3).answer = 1450;
    question(input, 0, 4).answer = 351; // keep numeric answers distinct
  });
  assert.deepEqual(codes(errors), []);
});

test("a background answer sitting in the passage is rejected", () => {
  const { errors } = check((input) => {
    question(input, 0, 7).answer = "delta";
  });
  // Also collides with the green answer, which is its own defect.
  assert.ok(codes(errors).includes("E_BACKGROUND_IN_TEXT"));
  assert.match(
    errors.find((e) => e.code === "E_BACKGROUND_IN_TEXT").message,
    /knowledge from outside the lesson/,
  );
});

test("a background question with no context field is rejected", () => {
  const { errors } = check((input) => {
    question(input, 2, 7).background = "   ";
  });
  assert.deepEqual(codes(errors), ["E_BACKGROUND_NO_CONTEXT"]);
});

test("spelling words must be 6-9 letters", () => {
  const { errors } = check((input) => {
    input.sections[0].blocks[2].words = [
      "cat",
      "meander",
      "estuary",
      "tributary",
    ];
  });
  assert.deepEqual(codes(errors), ["E_SPELLING_LENGTH"]);
  assert.match(errors[0].message, /"cat" is 3 letters/);
});

test("a spelling word hiding inside an answer is a collision", () => {
  const { errors } = check((input) => {
    // PRISON inside "the prisoner's dilemma" — the canonical case.
    input.sections[0].blocks[2].words = [
      "prison",
      "meander",
      "estuary",
      "tributary",
    ];
    input.sections[0].blocks[0].text +=
      " Some call this the prisoner's dilemma of rivers.";
    question(input, 0, 0).answer = "the prisoner's dilemma";
  });
  assert.ok(codes(errors).includes("E_SPELLING_COLLISION"));
  const collision = errors.find((e) => e.code === "E_SPELLING_COLLISION");
  // Quoted back as the author wrote them, not as the normaliser saw them.
  assert.match(collision.message, /"prison"/);
  assert.match(collision.message, /"the prisoner's dilemma"/);
});

test("a spelling word repeated in another section is rejected", () => {
  const { errors } = check((input) => {
    input.sections[3].blocks[2].words[0] = "torrent"; // already in section 1
  });
  assert.deepEqual(codes(errors), ["E_SPELLING_DUPLICATE"]);
  assert.match(errors[0].message, /section 1 and section 4/);
});

test("a spelling word that is also ALL-CAPS vocabulary only warns", () => {
  const { errors, warnings } = check((input) => {
    input.sections[0].blocks[0].text = input.sections[0].blocks[0].text.replace(
      "TRICKLE",
      "MEANDER",
    );
  });
  assert.deepEqual(codes(errors), []);
  assert.deepEqual(codes(warnings), ["W_SPELLING_IN_CAPS"]);
});

test("one answer word answers one question, at any length and across sections", () => {
  const shortWord = check((input) => {
    // "ash" is a green answer in section 6; reusing it as an orange option
    // anywhere is the defect the old 6-letter rule let through.
    question(input, 5, 5).answers = ["ash", "pumice"];
  });
  assert.ok(codes(shortWord.errors).includes("E_ANSWER_WORD_REUSED"));

  const acrossSections = check((input) => {
    input.sections[3].blocks[0].text += " A boulder sits in the stream.";
    question(input, 3, 5).answers = ["boulder", "moss"]; // boulder is section 1's
  });
  assert.ok(codes(acrossSections.errors).includes("E_ANSWER_WORD_REUSED"));
});

test("a one-word answer reappearing inside a longer answer is a reuse", () => {
  const { errors } = check((input) => {
    input.sections[3].blocks[0].text += " The maple canopy is dense.";
    question(input, 3, 0).answer = "maple canopy";
  });
  assert.ok(codes(errors).includes("E_ANSWER_WORD_REUSED"));
  assert.match(
    errors.find((e) => e.code === "E_ANSWER_WORD_REUSED").message,
    /also appears inside the answer/,
  );
});

test("distinct whole answers sharing a theme word are allowed", () => {
  const { errors } = check((input) => {
    input.sections[5].blocks[0].text +=
      " A shield volcano and a stratovolcano form differently.";
    question(input, 5, 0).answer = "a shield volcano";
    question(input, 5, 1).answer = "a stratovolcano";
  });
  assert.deepEqual(codes(errors), []);
});

test("two questions resolving to the same number is rejected", () => {
  const { errors } = check((input) => {
    question(input, 2, 4).answer = 350; // section 1's word problem already lands there
  });
  assert.deepEqual(codes(errors), ["E_NUMBER_DUPLICATE"]);
  assert.match(errors[0].message, /section 1 and section 3/);
});

test("two questions in the same section sharing a number say so plainly", () => {
  const { errors } = check((input) => {
    // Both purple questions land on 7, which is also the fill-in-the-blank's
    // value — "section 1 and section 1" would leave the author hunting.
    question(input, 0, 4).answer = 7;
  });
  assert.deepEqual(codes(errors), ["E_NUMBER_DUPLICATE"]);
  assert.match(errors[0].message, /both in section 1/);
  assert.doesNotMatch(errors[0].message, /section 1 and section 1/);
});

test("the retired 'comes to mind' stem is rejected", () => {
  const { errors } = check((input) => {
    question(input, 0, 8).prompt =
      "Give one word that comes to mind when you think of a river.";
  });
  assert.ok(codes(errors).includes("E_RETIRED_STEM"));
  assert.match(
    errors.find((e) => e.code === "E_RETIRED_STEM").message,
    /Name a color of a crayon/,
  );
});

test("an open question carrying an answer is rejected from the raw input", () => {
  const input = lessonInput();
  question(input, 0, 8).exampleAnswer = "blue";
  question(input, 1, 9).answer = "red";
  const findings = validateInput(inputBlocksFromSections(input.sections));
  assert.deepEqual(codes(findings), ["E_OPEN_HAS_ANSWER", "E_OPEN_HAS_ANSWER"]);
  assert.match(findings[0].message, /`exampleAnswer`/);
  assert.match(findings[1].message, /`answer`/);
});

// patch_lesson feeds validateInput from operations rather than sections, so the
// rule has to reach that write path too.
test("an open question carrying an answer is rejected when it arrives via a patch", () => {
  const findings = validateInput(
    inputBlocksFromOperations([
      { op: "set_title", title: "Renamed" },
      {
        op: "add_block",
        sectionId: "s1",
        block: {
          type: "question",
          questionType: "open",
          prompt: "Name a color.",
          exampleAnswer: "blue",
        },
      },
      {
        op: "add_section",
        name: "New",
        blocks: [
          { type: "text", text: "Prose." },
          {
            type: "question",
            questionType: "open",
            prompt: "Name a fruit.",
            answers: ["apple"],
          },
        ],
      },
    ]),
  );

  assert.deepEqual(codes(findings), ["E_OPEN_HAS_ANSWER", "E_OPEN_HAS_ANSWER"]);
  assert.match(findings[0].message, /Operation 2 \(add_block\)/);
  assert.match(findings[0].message, /`exampleAnswer`/);
  assert.match(findings[1].message, /Operation 3 \(add_section\), block 2/);
  assert.match(findings[1].message, /`answers`/);
});

test("formatFindings caps the list and says how many it held back", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    level: "error",
    code: "E_GROUNDING_SINGLE",
    key: `k${i}`,
    section: 1,
    message: `defect ${i}`,
  }));

  const capped = formatFindings(many, 25);
  const lines = capped.split("\n");
  assert.equal(lines.length, 26, "25 findings plus the summary line");
  assert.match(lines[0], /^1\. \[E_GROUNDING_SINGLE\] defect 0$/);
  assert.match(lines[24], /^25\. \[E_GROUNDING_SINGLE\] defect 24$/);
  assert.match(lines[25], /and 5 more/);
  assert.doesNotMatch(capped, /defect 25/);

  // Under the cap there is nothing to hold back, so no summary line.
  const short = formatFindings(many.slice(0, 3), 25);
  assert.equal(short.split("\n").length, 3);
  assert.doesNotMatch(short, /more/);
});

test("validationErrorMessage states the count and points at the escape hatch", () => {
  const one = validationErrorMessage([
    {
      level: "error",
      code: "E_SPELLING_LENGTH",
      key: "k",
      section: 2,
      message: 'Section 2: the spelling word "cat" is 3 letters.',
    },
  ]);
  assert.match(one, /1 problem to fix/);
  assert.match(one, /nothing was saved/);
  assert.match(one, /\[E_SPELLING_LENGTH\]/);
  assert.match(one, /"cat" is 3 letters/);
  assert.match(one, /"skipValidation": true/);

  const two = validationErrorMessage([
    { level: "error", code: "A", key: "a", section: 1, message: "first" },
    { level: "error", code: "B", key: "b", section: 1, message: "second" },
  ]);
  assert.match(two, /2 problems to fix/, "pluralised");
});

test("shape deviations warn rather than block", () => {
  const short = check((input) => {
    input.sections = input.sections.slice(0, 3);
  });
  assert.deepEqual(codes(short.errors), []);
  assert.ok(codes(short.warnings).includes("W_SECTION_COUNT"));
  assert.equal(
    short.warnings.find((w) => w.code === "W_SECTION_COUNT").section,
    null,
  );

  const reordered = check((input) => {
    const questions = input.sections[0].blocks.filter(
      (b) => b.type === "question",
    );
    questions[0].questionType = "open";
    delete questions[0].answer;
  });
  assert.ok(codes(reordered.warnings).includes("W_QUESTION_SHAPE"));

  const noSteps = check((input) => {
    delete question(input, 0, 4).steps;
  });
  assert.ok(codes(noSteps.warnings).includes("W_NUMBER_NO_STEPS"));

  const spellingCount = check((input) => {
    input.sections[0].blocks[2].words = ["torrent", "meander"];
  });
  assert.ok(codes(spellingCount.warnings).includes("W_SPELLING_COUNT"));
});

test("pink questions that don't split 4 tight + 3 extended warn", () => {
  const { errors, warnings } = check((input) => {
    question(input, 0, 8).prompt =
      "In your own words, explain how a delta forms over many centuries.";
  });
  assert.deepEqual(codes(errors), []);
  assert.deepEqual(codes(warnings), ["W_OPEN_SPLIT"]);
});

test("newFindings keeps only what an edit introduced", () => {
  const input = lessonInput();
  const before = buildDoc(input);
  const beforeResult = validateLesson(before);

  // Break the lesson the way a patch would, then confirm only the new defect
  // survives the baseline filter — this is what stops a one-line patch being
  // blocked by problems it didn't cause.
  const broken = buildDoc(
    (() => {
      const next = lessonInput();
      question(next, 0, 0).answer = "shingle";
      return next;
    })(),
  );
  const afterResult = validateLesson(broken);
  const introduced = newFindings(beforeResult.errors, afterResult.errors);
  assert.deepEqual(codes(introduced), ["E_GROUNDING_SINGLE"]);

  // And a lesson that was already broken before the edit reports nothing new.
  assert.deepEqual(newFindings(afterResult.errors, afterResult.errors), []);
});

test("a new defect matching a pre-existing one's code and value is still reported", () => {
  // Keying a finding on its code and offending value alone was not enough: a
  // patch could add a genuinely new question carrying the same defect on the same
  // word, and the baseline filter would write it off as pre-existing. The block's
  // own id is what separates them.
  const before = buildDoc({
    title: "T",
    sections: [
      {
        name: "One",
        blocks: [
          { type: "text", text: "The delta spreads wide." },
          {
            type: "question",
            questionType: "background",
            prompt: "Q1",
            background: "ctx",
            answer: "delta",
          },
        ],
      },
      {
        name: "Two",
        blocks: [{ type: "text", text: "A delta forms slowly." }],
      },
    ],
  });
  const beforeErrors = validateLesson(before).errors;
  assert.deepEqual(codes(beforeErrors), ["E_BACKGROUND_IN_TEXT"]);

  const after = applyPatch(before, [
    {
      op: "add_block",
      sectionId: before.sections[1].id,
      block: {
        type: "question",
        questionType: "background",
        prompt: "Q2",
        background: "ctx",
        answer: "delta",
      },
    },
  ]);
  const introduced = newFindings(beforeErrors, validateLesson(after).errors);
  assert.deepEqual(codes(introduced), ["E_BACKGROUND_IN_TEXT"]);
  assert.equal(introduced[0].section, 2, "the new one, not the inherited one");
});

test("a patch that renumbers sections doesn't resurrect pre-existing findings", () => {
  const input = lessonInput();
  input.sections[4].blocks[2].words[0] = "torrent"; // pre-existing duplicate
  input.sections[4].blocks[2].words.push("shipping"); // pre-existing 5th word
  const before = buildDoc(input);
  const beforeResult = validateLesson(before);
  assert.ok(codes(beforeResult.errors).includes("E_SPELLING_DUPLICATE"));
  assert.ok(codes(beforeResult.warnings).includes("W_SPELLING_COUNT"));

  // Move the offending section to the front. Two things could betray the
  // finding's identity: the section's number, and — for a collision, which names
  // two parties — which end of the pair the walk reaches first. Neither may.
  const after = applyPatch(before, [
    { op: "move_section", sectionId: before.sections[4].id, index: 0 },
  ]);
  const afterResult = validateLesson(after);
  assert.deepEqual(
    codes(newFindings(beforeResult.errors, afterResult.errors)),
    [],
  );
  assert.deepEqual(
    codes(newFindings(beforeResult.warnings, afterResult.warnings)),
    [],
  );
});

test("rich-text passages are flattened before grounding", () => {
  const { errors } = check((input) => {
    input.sections[0].blocks[0].text =
      "<p>The river sorts its load into <strong>boulder</strong>, cobble, and silt.</p>" +
      "<p>It cuts a channel and drags gravel along the bed.</p>";
    input.sections[0].blocks[1].text =
      "<p>Willow, alder, and hazel line the delta, 7 kilometres wide.</p>";
  });
  assert.deepEqual(codes(errors), []);
});
