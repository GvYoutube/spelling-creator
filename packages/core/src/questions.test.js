// Covers the parts of the question model the printed lesson leans on: the
// inline answer text, the footer legend, and the Word style names the DOCX
// round trip uses to recover a question's type now that nothing in the visible
// text names it.

import { describe, expect, it } from "vitest";

import {
  ANSWER_GAP,
  QUESTION_LEGEND,
  QUESTION_TYPES,
  QUESTION_TYPE_LIST,
  createQuestionBlock,
  questionAnswerText,
  questionMeta,
  questionStyleClass,
  questionStyleMap,
} from "./questions.js";
import { normalizeLessonFile } from "./jsonImport.js";

let counter = 0;
const newId = () => `id-${(counter += 1)}`;

describe("questionAnswerText", () => {
  it("returns the stored answer for the single-answer types", () => {
    for (const type of ["single", "background"]) {
      expect(
        questionAnswerText({ questionType: type, answer: "FLOODING" }),
      ).toBe("FLOODING");
    }
    expect(
      questionAnswerText({
        questionType: "number",
        answer: "1928 - 1902 = 26",
      }),
    ).toBe("1928 - 1902 = 26");
  });

  it("joins several accepted answers with the printed gap", () => {
    expect(
      questionAnswerText({
        questionType: "multiple",
        answers: [{ text: "NEVADA" }, { text: " ARIZONA " }, { text: "" }],
      }),
    ).toBe(`NEVADA${ANSWER_GAP}ARIZONA`);
  });

  it("gives the free-response types nothing to print after the prompt", () => {
    expect(questionAnswerText({ questionType: "open" })).toBe("");
    expect(questionAnswerText({ questionType: "paraphrase" })).toBe("");
  });

  it("prints nothing for an unanswered question", () => {
    expect(questionAnswerText({ questionType: "single", answer: "" })).toBe("");
    expect(questionAnswerText({ questionType: "multiple", answers: [] })).toBe(
      "",
    );
    expect(questionAnswerText(null)).toBe("");
  });

  it("separates answers with a gap HTML will not collapse", () => {
    // The PDF renders the docx as HTML, which folds a run of ordinary spaces
    // down to one; the non-breaking space is what survives that.
    expect(ANSWER_GAP).toContain(" ");
  });
});

describe("paraphrase questions", () => {
  it("is a type of its own, in its own colour", () => {
    expect(QUESTION_TYPES.paraphrase.color).not.toBe(
      QUESTION_TYPES.multiple.color,
    );
    expect(QUESTION_TYPES.paraphrase.color).not.toBe(QUESTION_TYPES.open.color);
  });

  it("builds with no answer field, like an open question", () => {
    expect(createQuestionBlock(newId, "paraphrase")).toEqual({
      id: expect.any(String),
      type: "question",
      questionType: "paraphrase",
      prompt: "",
    });
  });

  it("survives a lesson-file import", () => {
    const doc = normalizeLessonFile({
      title: "T",
      sections: [
        {
          name: "S",
          blocks: [
            {
              type: "question",
              questionType: "paraphrase",
              prompt: "In your own words, explain why.",
            },
          ],
        },
      ],
    });
    expect(doc.sections[0].blocks).toHaveLength(1);
    expect(doc.sections[0].blocks[0].questionType).toBe("paraphrase");
  });
});

describe("the footer legend", () => {
  it("names every question type exactly once", () => {
    expect(QUESTION_LEGEND).toHaveLength(QUESTION_TYPE_LIST.length);
    expect(new Set(QUESTION_LEGEND.map((q) => q.key)).size).toBe(
      QUESTION_TYPE_LIST.length,
    );
  });

  it("gives every type a distinct colour, since colour is the only marking", () => {
    const colors = QUESTION_TYPE_LIST.map((q) => q.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe("the Word styles the DOCX round trip rides on", () => {
  it("maps every type onto its own class", () => {
    const classes = QUESTION_TYPE_LIST.map((q) => questionStyleClass(q.key));
    expect(new Set(classes).size).toBe(classes.length);
  });

  it("emits one mammoth rule per type, naming that type's style and class", () => {
    const map = questionStyleMap();
    expect(map).toHaveLength(QUESTION_TYPE_LIST.length);
    for (const type of QUESTION_TYPE_LIST) {
      expect(map).toContainEqual(
        expect.stringContaining(questionStyleClass(type.key)),
      );
      expect(map).toContainEqual(expect.stringContaining(type.label));
    }
  });
});

describe("questionMeta", () => {
  it("falls back to open for a type it doesn't know", () => {
    expect(questionMeta("nonsense")).toBe(QUESTION_TYPES.open);
  });
});
