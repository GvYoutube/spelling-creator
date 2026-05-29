// Shared definitions for the five question types. Imported by the editor
// (SectionCard / ContentBlock) and the exporters so colours, labels, and the
// default block shape stay in sync everywhere.

export const QUESTION_TYPES = {
  number: {
    key: "number",
    label: "Number answer",
    short: "Number",
    description: "The answer is a number",
    color: "#7048e8", // purple
  },
  single: {
    key: "single",
    label: "Single answer",
    short: "Single",
    description: "One correct option",
    color: "#2f9e44", // green
  },
  multiple: {
    key: "multiple",
    label: "Multiple answers",
    short: "Multiple",
    description: "Several correct options",
    color: "#e8590c", // orange
  },
  open: {
    key: "open",
    label: "Open ended",
    short: "Open",
    description: "Free written response",
    color: "#e64980", // pink
  },
  background: {
    key: "background",
    label: "Background knowledge",
    short: "Background",
    description: "Requires prior knowledge",
    color: "#1c7ed6", // blue
  },
};

export const QUESTION_TYPE_LIST = Object.values(QUESTION_TYPES);

export function questionMeta(questionType) {
  return QUESTION_TYPES[questionType] || QUESTION_TYPES.open;
}

// Build a fresh question block of the given type. `newId` is injected so this
// stays decoupled from the id helper.
export function createQuestionBlock(newId, questionType) {
  const base = { id: newId(), type: "question", questionType, prompt: "" };
  switch (questionType) {
    case "number":
      return { ...base, answer: "" };
    case "single":
      return {
        ...base,
        options: [
          { id: newId(), text: "" },
          { id: newId(), text: "" },
        ],
        correctId: null,
      };
    case "multiple":
      return {
        ...base,
        options: [
          { id: newId(), text: "" },
          { id: newId(), text: "" },
        ],
        correctIds: [],
      };
    case "open":
      return { ...base, answerLines: 3 };
    case "background":
      return { ...base, background: "" };
    default:
      return base;
  }
}
