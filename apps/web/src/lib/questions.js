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
    description: "One typed answer",
    color: "#2f9e44", // green
  },
  multiple: {
    key: "multiple",
    label: "Multiple answers",
    short: "Multiple",
    description: "Several accepted answers",
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
      return { ...base, answer: "" };
    case "multiple":
      return { ...base, answers: [{ id: newId(), text: "" }] };
    case "open":
      return { ...base, exampleAnswer: "" };
    case "background":
      return { ...base, background: "", answer: "" };
    default:
      return base;
  }
}

// Build a question block from an AI suggestion (see lib/aiSuggest.js). `data`
// is the JSON the Worker returns for the given type; this maps it onto the same
// block shape `createQuestionBlock` produces. Anything missing falls back to
// sensible blanks so the resulting block is always editable, even if the model
// returns a partial answer.
export function buildQuestionBlock(newId, questionType, data = {}) {
  const prompt = typeof data.prompt === "string" ? data.prompt : "";
  const base = { id: newId(), type: "question", questionType, prompt };
  switch (questionType) {
    case "number":
      return {
        ...base,
        answer: data.answer != null ? String(data.answer) : "",
      };
    case "single":
      return {
        ...base,
        answer: typeof data.answer === "string" ? data.answer : "",
      };
    case "multiple":
      return { ...base, answers: toAnswers(newId, data.answers) };
    case "open":
      return {
        ...base,
        exampleAnswer:
          typeof data.exampleAnswer === "string" ? data.exampleAnswer : "",
      };
    case "background":
      return {
        ...base,
        background: typeof data.background === "string" ? data.background : "",
        answer: typeof data.answer === "string" ? data.answer : "",
      };
    default:
      return base;
  }
}

// Turn an array of answer strings into answer objects, guaranteeing at least
// one editable row so an AI-suggested block matches a hand-made one.
function toAnswers(newId, raw) {
  const list = Array.isArray(raw)
    ? raw.filter((t) => typeof t === "string")
    : [];
  const answers = list.map((text) => ({ id: newId(), text }));
  if (answers.length === 0) answers.push({ id: newId(), text: "" });
  return answers;
}
