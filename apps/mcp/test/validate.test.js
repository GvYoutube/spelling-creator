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
  inputBlocksFromSections,
  newFindings,
  normalizeText,
  validateInput,
  validateLesson,
} from "../src/validate.js";

// A section written to the standard: 2 paragraphs holding every answer the
// questions ask for, 4 spelling words that appear in no answer, and 15 questions
// in the fixed order.
const SECTIONS = [
  {
    name: "Rivers",
    paragraphs: [
      "A river begins as a TRICKLE high in the hills. It carries gravel and silt down the slope, " +
        "shouldering past every boulder in its way. The water cuts a channel through soft ground, and " +
        "that channel deepens a little more each year.",
      "Near the sea the river slows and spreads into a delta. A heron stands in the shallows and a " +
        "willow leans out over the bank. The delta here is 7 kilometres wide, and it is still growing " +
        "as the SEDIMENT settles.",
    ],
    spelling: ["torrent", "meander", "estuary", "tributary"],
    greens: ["gravel", "channel", "delta"],
    fill: 7,
    problem: { answer: 350, steps: ["50 x 7 = 350"] },
    oranges: [
      ["boulder", "silt"],
      ["heron", "willow"],
    ],
    background: "ocean",
  },
  {
    name: "Mountains",
    paragraphs: [
      "A mountain ridge is built and then taken apart. Frost splits the granite, and the broken pieces " +
        "slide down as scree until the slope below is buried in it. The ALPINE air is thin enough that " +
        "climbers move slowly.",
      "Between two peaks sits a saddle, the low crossing point every path uses. Higher up, the summit " +
        "holds snow for 4 months of the year. A marmot whistles from the rocks, and lichen clings to " +
        "the stone where nothing else will GERMINATE.",
    ],
    spelling: ["crevasse", "altitude", "plateau", "avalanche"],
    greens: ["ridge", "saddle", "summit"],
    fill: 4,
    problem: { answer: 128, steps: ["2 to the power of 7 = 128"] },
    oranges: [
      ["scree", "granite"],
      ["marmot", "lichen"],
    ],
    background: "compass",
  },
  {
    name: "Deserts",
    paragraphs: [
      "A dune moves. Wind lifts the grains up the gentle side and drops them down the steep one, so the " +
        "whole ridge of sand walks slowly downwind. Underneath lies sandstone, and in places a seam of " +
        "gypsum so soft it can be scratched with a fingernail.",
      "Where water reaches the surface an oasis appears, and everything living crowds around it. A " +
        "cactus stores what it can. A scorpion waits out the heat under a stone, and a gecko runs across " +
        "sand that is 12 degrees hotter than the air above it. The land looks ARID but it is not empty.",
    ],
    spelling: ["aquifer", "drought", "sirocco", "erosion"],
    greens: ["dune", "oasis", "cactus"],
    fill: 12,
    problem: { answer: 96, steps: ["12 x 8 = 96"] },
    oranges: [
      ["scorpion", "gecko"],
      ["sandstone", "gypsum"],
    ],
    background: "camel",
  },
  {
    name: "Forests",
    paragraphs: [
      "The canopy takes the light first, and everything below lives on what gets past it. A maple and a " +
        "cedar can stand side by side and reach it by different routes. Rain runs down the bark in " +
        "channels worn by a century of it.",
      "On the floor, a fungus breaks down what falls. Moss holds water like a sponge, and a beetle works " +
        "through the dead wood. A single fallen trunk can feed the soil for 30 years, which is why a " +
        "cleared forest is so hard to REPLICATE.",
    ],
    spelling: ["seedling", "thicket", "humidity", "sapwood"],
    greens: ["canopy", "fungus", "bark"],
    fill: 30,
    problem: { answer: 720, steps: ["30 x 24 = 720"] },
    oranges: [
      ["beetle", "moss"],
      ["maple", "cedar"],
    ],
    background: "chlorophyll",
  },
  {
    name: "Oceans",
    paragraphs: [
      "A current is a river inside the sea, and it does not mix with the water it runs through. Plankton " +
        "drifts wherever it is carried, and everything larger follows. A dolphin hunts along the edge of " +
        "one, where the food is densest.",
      "Closer in, a reef builds itself out of its own skeletons. Kelp anchors to rock and grows toward " +
        "the light. A barnacle cements itself head-first and never moves again; an urchin grazes the " +
        "rock bare. The shelf here runs out to 200 metres before the floor drops into the PELAGIC dark.",
    ],
    spelling: ["seabed", "trawler", "buoyancy", "salinity"],
    greens: ["current", "plankton", "reef"],
    fill: 200,
    problem: { answer: 1500, steps: ["200 x 7.5 = 1500"] },
    oranges: [
      ["barnacle", "kelp"],
      ["dolphin", "urchin"],
    ],
    background: "tsunami",
  },
  {
    name: "Volcanoes",
    paragraphs: [
      "Magma is rock that has given up being solid. Where it reaches the surface through a fissure it " +
        "runs out as INCANDESCENT sheets and cools into basalt, dark and heavy. Where it arrives full of " +
        "gas it comes apart into pumice, light enough to float.",
      "A crater sits at the top of the vent. When a chamber empties, the roof above it drops and leaves a " +
        "caldera far wider than the mountain ever was. Ash travels furthest of all — a single eruption " +
        "can put it 900 kilometres downwind, which is why the record of one is so hard to MISREAD.",
    ],
    spelling: ["eruption", "volcanic", "tectonic", "sulphur"],
    greens: ["magma", "crater", "ash"],
    fill: 900,
    problem: { answer: 2700, steps: ["900 x 3 = 2700"] },
    oranges: [
      ["basalt", "pumice"],
      ["fissure", "caldera"],
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
      ...spec.oranges.map((answers, i) => ({
        type: "question",
        questionType: "multiple",
        prompt: `Name one of these (${i + 1}).`,
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
    const blocks = input.sections[0].blocks;
    const questions = blocks.filter((b) => b.type === "question");
    [questions[0].questionType, questions[0].answer] = ["open", undefined];
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

test("a patch that renumbers sections doesn't resurrect pre-existing findings", () => {
  const input = lessonInput();
  input.sections[4].blocks[2].words[0] = "torrent"; // pre-existing duplicate
  const before = buildDoc(input);
  const beforeResult = validateLesson(before);
  assert.ok(codes(beforeResult.errors).includes("E_SPELLING_DUPLICATE"));

  // Move the offending section; the finding's identity must not move with it.
  const after = applyPatch(before, [
    { op: "move_section", sectionId: before.sections[4].id, index: 0 },
  ]);
  const introduced = newFindings(
    beforeResult.errors,
    validateLesson(after).errors,
  );
  assert.deepEqual(codes(introduced), []);
});

test("rich-text passages are flattened before grounding", () => {
  const { errors } = check((input) => {
    input.sections[0].blocks[0].text =
      "<p>The river carries <strong>gravel</strong> past a boulder.</p>" +
      "<p>It cuts a channel and drops silt.</p>";
    input.sections[0].blocks[1].text =
      "<p>A heron waits by a willow near the delta, 7 kilometres wide.</p>";
  });
  assert.deepEqual(codes(errors), []);
});
