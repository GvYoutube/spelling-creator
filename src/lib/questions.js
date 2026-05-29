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

// Build a question block from an AI suggestion (see lib/aiSuggest.js). `data`
// is the JSON the Worker returns for the given type; this maps it onto the same
// block shape `createQuestionBlock` produces, turning option indexes back into
// option ids. Anything missing falls back to sensible blanks so the resulting
// block is always editable, even if the model returns a partial answer.
export function buildQuestionBlock(newId, questionType, data = {}) {
  const prompt = typeof data.prompt === "string" ? data.prompt : "";
  const base = { id: newId(), type: "question", questionType, prompt };
  switch (questionType) {
    case "number":
      return { ...base, answer: data.answer != null ? String(data.answer) : "" };
    case "single": {
      const options = toOptions(newId, data.options);
      const idx = Number.isInteger(data.correctIndex) ? data.correctIndex : -1;
      return { ...base, options, correctId: options[idx]?.id ?? null };
    }
    case "multiple": {
      const options = toOptions(newId, data.options);
      const idxs = Array.isArray(data.correctIndexes) ? data.correctIndexes : [];
      const correctIds = idxs.map((i) => options[i]?.id).filter(Boolean);
      return { ...base, options, correctIds };
    }
    case "open":
      return { ...base, answerLines: 3 };
    case "background":
      return {
        ...base,
        background: typeof data.background === "string" ? data.background : "",
      };
    default:
      return base;
  }
}

// Turn an array of option strings into option objects, guaranteeing at least
// two editable rows so an AI-suggested block matches a hand-made one.
function toOptions(newId, raw) {
  const list = Array.isArray(raw) ? raw.filter((t) => typeof t === "string") : [];
  const options = list.map((text) => ({ id: newId(), text }));
  while (options.length < 2) options.push({ id: newId(), text: "" });
  return options;
}
