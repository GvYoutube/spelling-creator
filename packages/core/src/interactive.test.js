import { describe, expect, it } from "vitest";
import {
  MAX_RESPONSES,
  MAX_RESPONSE_LENGTH,
  buildInteractiveSteps,
  collectResponses,
  countInteractiveQuestions,
  hasRevealableAnswers,
  isInteractivePlayable,
  questionAnswer,
  stepSpeechText,
  validateResponses,
} from "./interactive.js";

const doc = {
  title: "Volcanoes",
  sections: [
    {
      id: "s1",
      name: "What is a volcano?",
      blocks: [
        { id: "b1", type: "text", text: "A volcano is a mountain." },
        {
          id: "b2",
          type: "image",
          image: "abc",
          caption: "Mount Etna erupting",
        },
        {
          id: "b3",
          type: "question",
          questionType: "single",
          prompt: "Where?",
          answer: "Italy",
        },
        { id: "b4", type: "question", questionType: "open", prompt: "Why?" },
      ],
    },
    {
      id: "s2",
      name: "Spelling",
      blocks: [
        {
          id: "b5",
          type: "spelling",
          words: [
            { id: "w1", text: "LAVA" },
            { id: "w2", text: "MAGMA" },
          ],
        },
      ],
    },
  ],
};

describe("buildInteractiveSteps", () => {
  it("puts a section's material first, then its questions in order", () => {
    const steps = buildInteractiveSteps(doc);
    expect(steps.map((s) => s.kind)).toEqual([
      "content",
      "question",
      "question",
      "content",
    ]);
    // The content step carries only the non-question blocks.
    expect(steps[0].blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(steps[1].block.id).toBe("b3");
    expect(steps[2].block.id).toBe("b4");
  });

  it("numbers questions from 1 within each section", () => {
    const steps = buildInteractiveSteps({
      sections: [
        { id: "a", blocks: [{ id: "q1", type: "question", prompt: "one" }] },
        {
          id: "b",
          blocks: [
            { id: "q2", type: "question", prompt: "two" },
            { id: "q3", type: "question", prompt: "three" },
          ],
        },
      ],
    });
    expect(steps.map((s) => s.questionNumber)).toEqual([1, 1, 2]);
  });

  it("skips the content step for an all-questions section", () => {
    const steps = buildInteractiveSteps({
      sections: [
        { id: "a", blocks: [{ id: "q1", type: "question", prompt: "?" }] },
      ],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("question");
  });

  it("plays a lesson with no questions at all", () => {
    const steps = buildInteractiveSteps({
      sections: [
        { id: "a", blocks: [{ id: "t", type: "text", text: "Hello" }] },
      ],
    });
    expect(steps.map((s) => s.kind)).toEqual(["content"]);
  });

  it("survives documents with nothing in them", () => {
    expect(buildInteractiveSteps(null)).toEqual([]);
    expect(buildInteractiveSteps({})).toEqual([]);
    expect(buildInteractiveSteps({ sections: [{}] })).toEqual([]);
  });

  it("gives id-less sections and blocks stable positional keys", () => {
    const steps = buildInteractiveSteps({
      sections: [{ blocks: [{ type: "question", prompt: "?" }] }],
    });
    expect(steps[0].key).toBe("section-0:block-0");
    expect(steps[0].sectionId).toBe("section-0");
  });
});

describe("countInteractiveQuestions", () => {
  it("counts every question across every section", () => {
    expect(countInteractiveQuestions(doc)).toBe(2);
    expect(countInteractiveQuestions({ sections: [] })).toBe(0);
    expect(countInteractiveQuestions(undefined)).toBe(0);
  });
});

describe("isInteractivePlayable", () => {
  it("is true for any lesson with a block in it", () => {
    expect(isInteractivePlayable(doc)).toBe(true);
  });

  it("is false for an empty document or one with only empty sections", () => {
    expect(isInteractivePlayable(undefined)).toBe(false);
    expect(isInteractivePlayable({ sections: [] })).toBe(false);
    expect(
      isInteractivePlayable({ sections: [{ name: "Empty", blocks: [] }] }),
    ).toBe(false);
  });
});

describe("stepSpeechText", () => {
  it("reads the section name, prose and captions of a content step", () => {
    const [content] = buildInteractiveSteps(doc);
    expect(stepSpeechText(content)).toBe(
      "What is a volcano?\nA volcano is a mountain.\nMount Etna erupting",
    );
  });

  it("reads spelling words as a list", () => {
    const steps = buildInteractiveSteps(doc);
    expect(stepSpeechText(steps[3])).toBe("Spelling\nLAVA, MAGMA");
  });

  it("reads a question's prompt but never its answer", () => {
    const steps = buildInteractiveSteps(doc);
    const spoken = stepSpeechText(steps[1]);
    expect(spoken).toContain("Where?");
    expect(spoken).not.toContain("Italy");
  });

  it("returns nothing for a missing step", () => {
    expect(stepSpeechText(null)).toBe("");
  });
});

describe("questionAnswer", () => {
  it("reads a single or background question's answer", () => {
    expect(
      questionAnswer({
        type: "question",
        questionType: "single",
        answer: " Italy ",
      }),
    ).toEqual({ answer: "Italy", answers: [], steps: [] });
    expect(
      questionAnswer({
        type: "question",
        questionType: "background",
        answer: "Tectonic plates",
      }),
    ).toEqual({ answer: "Tectonic plates", answers: [], steps: [] });
  });

  it("reads a number question's answer and its working", () => {
    expect(
      questionAnswer({
        type: "question",
        questionType: "number",
        answer: "12",
        steps: [{ text: "4 × 3" }, { text: "  " }],
      }),
    ).toEqual({ answer: "12", answers: [], steps: ["4 × 3"] });
  });

  it("reveals working even when the total was left blank", () => {
    expect(
      questionAnswer({
        type: "question",
        questionType: "number",
        steps: [{ text: "Count the syllables" }],
      }),
    ).toEqual({ answer: "", answers: [], steps: ["Count the syllables"] });
  });

  it("reads every accepted answer of a multiple question", () => {
    expect(
      questionAnswer({
        type: "question",
        questionType: "multiple",
        answers: [{ text: "lava" }, { text: "" }, { text: "magma" }],
      }),
    ).toEqual({ answer: "", answers: ["lava", "magma"], steps: [] });
  });

  it("has nothing to reveal for an open question, a blank one, or a non-question", () => {
    expect(
      questionAnswer({
        type: "question",
        questionType: "open",
        answer: "ignored",
      }),
    ).toBeNull();
    expect(
      questionAnswer({
        type: "question",
        questionType: "single",
        answer: "  ",
      }),
    ).toBeNull();
    expect(
      questionAnswer({
        type: "question",
        questionType: "multiple",
        answers: [],
      }),
    ).toBeNull();
    expect(questionAnswer({ type: "text", text: "Not a question" })).toBeNull();
    expect(questionAnswer(null)).toBeNull();
  });
});

describe("hasRevealableAnswers", () => {
  it("is true when any question has an answer behind it", () => {
    expect(hasRevealableAnswers(buildInteractiveSteps(doc))).toBe(true);
  });

  it("is false for a lesson whose questions are all open or unanswered", () => {
    const steps = buildInteractiveSteps({
      sections: [
        {
          id: "s1",
          blocks: [
            {
              id: "b1",
              type: "question",
              questionType: "open",
              prompt: "Why?",
            },
            {
              id: "b2",
              type: "question",
              questionType: "single",
              prompt: "Who?",
            },
          ],
        },
      ],
    });
    expect(hasRevealableAnswers(steps)).toBe(false);
  });

  it("is false for a lesson with no questions at all", () => {
    expect(hasRevealableAnswers([])).toBe(false);
    expect(hasRevealableAnswers(undefined)).toBe(false);
  });
});

describe("collectResponses", () => {
  const steps = buildInteractiveSteps(doc);

  it("snapshots the prompt and type alongside each answer", () => {
    expect(collectResponses(steps, { b3: "Italy", b4: "Pressure." })).toEqual([
      {
        blockId: "b3",
        sectionId: "s1",
        sectionName: "What is a volcano?",
        questionType: "single",
        prompt: "Where?",
        answer: "Italy",
      },
      {
        blockId: "b4",
        sectionId: "s1",
        sectionName: "What is a volcano?",
        questionType: "open",
        prompt: "Why?",
        answer: "Pressure.",
      },
    ]);
  });

  it("keeps skipped questions as blank answers rather than dropping them", () => {
    const collected = collectResponses(steps, { b4: "Pressure." });
    expect(collected).toHaveLength(2);
    expect(collected[0].answer).toBe("");
  });

  it("truncates an over-long answer to the shared limit", () => {
    const collected = collectResponses(steps, {
      b3: "x".repeat(MAX_RESPONSE_LENGTH + 100),
    });
    expect(collected[0].answer).toHaveLength(MAX_RESPONSE_LENGTH);
  });
});

describe("validateResponses", () => {
  it("accepts a well-formed submission", () => {
    expect(validateResponses([{ answer: "yes" }])).toBeNull();
    expect(validateResponses([])).toBeNull();
  });

  it("rejects anything that isn't a list of text answers", () => {
    expect(validateResponses("nope")).toBeTruthy();
    expect(validateResponses([null])).toBeTruthy();
    expect(validateResponses([{ answer: 42 }])).toBeTruthy();
  });

  it("rejects a submission past either limit", () => {
    expect(
      validateResponses([{ answer: "x".repeat(MAX_RESPONSE_LENGTH + 1) }]),
    ).toBeTruthy();
    expect(
      validateResponses(
        Array.from({ length: MAX_RESPONSES + 1 }, () => ({ answer: "" })),
      ),
    ).toBeTruthy();
  });
});
