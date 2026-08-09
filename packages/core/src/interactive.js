// Interactive lesson mode — turning a lesson document into an ordered walkthrough
// a learner steps through one screen at a time, typing an answer to each question.
//
// This is a *derived* view of the existing document, not a new document shape:
// nothing is added to `doc` when a lesson is authored, so every lesson ever
// published — including ones made before this feature existed, and ones written
// by the MCP server — is playable. A lesson with no questions is still playable;
// it simply has no answer fields.
//
// The walkthrough is built once per lesson and consists of two kinds of step:
//
//   content  — a section's non-question blocks (text, images, spelling words),
//              shown together as that section's material.
//   question — a single question block, with a text field for the learner's
//              answer. Questions come in document order within their section,
//              after that section's content.
//
// A section with no content blocks contributes no content step (an all-questions
// section goes straight to its first question), and a section with nothing in it
// at all contributes nothing. Question numbering restarts per section, matching
// the editor's `Q7`-style numbering.
//
// The learner's typed answers are stored privately in their account (see
// lessonResponses.js and the Worker's /lessons/:id/responses). The limits below
// are shared with the Worker so the browser and server agree on what a valid
// submission is.

// Block types that make up a section's material, in the order the document has
// them. Everything that isn't a question block and isn't unknown to us.
const CONTENT_BLOCK_TYPES = new Set(["text", "image", "spelling"]);

/** The longest single typed answer we accept. Long enough for an essay-style
 * open-ended response, short enough that a submission can't be a payload. */
export const MAX_RESPONSE_LENGTH = 5000;

/** The most answers one submission may carry — far above any real lesson (the
 * largest published lessons run to a few dozen questions). */
export const MAX_RESPONSES = 500;

/** How many completed run-throughs of one lesson a user may keep. Past that they
 * delete an old one first, rather than accumulating forever. */
export const MAX_STORED_RESPONSES = 20;

/**
 * Whether a block asks the learner something (and so gets its own step with an
 * answer field).
 * @param {object} block
 * @returns {boolean}
 */
export function isQuestionBlock(block) {
  return Boolean(block) && block.type === "question";
}

/**
 * Build the ordered walkthrough for a lesson document.
 *
 * @param {object} doc  The lesson document ({ title, sections: [{ name, blocks }] }).
 * @returns {Array<
 *   { key: string, kind: "content", sectionId: string, sectionIndex: number,
 *     sectionName: string, blocks: object[] } |
 *   { key: string, kind: "question", sectionId: string, sectionIndex: number,
 *     sectionName: string, block: object, questionNumber: number }
 * >} The steps, in the order they are presented.
 */
export function buildInteractiveSteps(doc) {
  const steps = [];
  const sections = Array.isArray(doc?.sections) ? doc.sections : [];

  sections.forEach((section, sectionIndex) => {
    const blocks = Array.isArray(section?.blocks) ? section.blocks : [];
    // A block with no id of its own (older documents, hand-written JSON) still
    // needs a stable React key and a stable answer key, so fall back to its
    // position — which is stable for as long as the document is.
    const sectionId = section?.id || `section-${sectionIndex}`;
    const sectionName = (section?.name || "").trim();

    const content = blocks.filter(
      (block) => block && CONTENT_BLOCK_TYPES.has(block.type),
    );
    if (content.length > 0) {
      steps.push({
        key: `${sectionId}:content`,
        kind: "content",
        sectionId,
        sectionIndex,
        sectionName,
        blocks: content,
      });
    }

    let questionNumber = 0;
    blocks.forEach((block, blockIndex) => {
      if (!isQuestionBlock(block)) return;
      questionNumber += 1;
      steps.push({
        key: `${sectionId}:${block.id || `block-${blockIndex}`}`,
        kind: "question",
        sectionId,
        sectionIndex,
        sectionName,
        block,
        questionNumber,
      });
    });
  });

  return steps;
}

/**
 * How many questions a lesson asks in total — what the walkthrough's progress
 * counter counts, and what tells the lesson page whether to offer interactive
 * mode as a practice run or just a read-through.
 * @param {object} doc
 * @returns {number}
 */
export function countInteractiveQuestions(doc) {
  return (Array.isArray(doc?.sections) ? doc.sections : []).reduce(
    (total, section) =>
      total +
      (Array.isArray(section?.blocks) ? section.blocks : []).filter(
        isQuestionBlock,
      ).length,
    0,
  );
}

/**
 * Whether a lesson has anything to walk through at all — i.e. whether offering
 * interactive mode would lead anywhere. False only for a genuinely empty document
 * (no sections, or sections with no blocks in them), which the hub can hold: a
 * lesson needs one section to publish, not one block.
 * @param {object} doc
 * @returns {boolean}
 */
export function isInteractivePlayable(doc) {
  return (Array.isArray(doc?.sections) ? doc.sections : []).some(
    (section) =>
      (Array.isArray(section?.blocks) ? section.blocks : []).length > 0,
  );
}

/**
 * The prose of one step, flattened for text-to-speech (see the web app's
 * useSpeech hook). Reading order matches what's on screen: the section name
 * first, then each block's words.
 *
 * Deliberately excluded: a question's *answer*. The block carries the author's
 * answer, and interactive mode never shows it — reading it aloud would be a
 * louder way of giving it away.
 *
 * @param {object} step  A step from buildInteractiveSteps.
 * @returns {string} Plain text, one utterance per line.
 */
export function stepSpeechText(step) {
  if (!step) return "";
  const lines = [];
  if (step.sectionName) lines.push(step.sectionName);

  if (step.kind === "question") {
    const prompt = (step.block?.prompt || "").trim();
    if (prompt) lines.push(prompt);
    return lines.join("\n");
  }

  for (const block of step.blocks || []) {
    if (block.type === "text") {
      const text = (block.text || "").trim();
      if (text) lines.push(text);
    } else if (block.type === "image") {
      const caption = (block.caption || "").trim();
      if (caption) lines.push(caption);
    } else if (block.type === "spelling") {
      const words = (block.words || [])
        .map((word) => (word.text || "").trim())
        .filter(Boolean);
      if (words.length) lines.push(words.join(", "));
    }
  }

  return lines.join("\n");
}

/**
 * The answer-field key for a question step. Answers are held (and stored) keyed
 * by block id so re-ordering a lesson between run-throughs doesn't shuffle which
 * answer belongs to which question.
 * @param {object} step
 * @returns {string}
 */
export function answerKey(step) {
  return step?.block?.id || step?.key || "";
}

/**
 * Shape the learner's typed answers into the payload stored in their account.
 *
 * The question's prompt and type are snapshotted alongside the answer on
 * purpose: a saved run-through has to stay readable years later even if the
 * lesson has since been edited, re-ordered, or had that question deleted
 * outright. Blank answers are kept — "I skipped question 3" is itself a fact
 * about the run-through, and dropping them would silently renumber the rest.
 *
 * @param {Array<object>} steps    Steps from buildInteractiveSteps.
 * @param {Record<string, string>} answers  Typed answers, keyed by answerKey(step).
 * @returns {Array<{blockId, sectionId, sectionName, questionType, prompt, answer}>}
 */
export function collectResponses(steps, answers) {
  return (steps || [])
    .filter((step) => step.kind === "question")
    .map((step) => ({
      blockId: answerKey(step),
      sectionId: step.sectionId,
      sectionName: step.sectionName,
      questionType: step.block?.questionType || "open",
      prompt: (step.block?.prompt || "").trim(),
      answer: (answers?.[answerKey(step)] || "").slice(0, MAX_RESPONSE_LENGTH),
    }));
}

/**
 * Validate a submission the way the Worker does, so the browser can refuse an
 * impossible save before making the round trip and the two agree on the reason.
 * Returns null when the payload is fine, or a short human-readable problem.
 * @param {Array<object>} responses
 * @returns {string|null}
 */
export function validateResponses(responses) {
  if (!Array.isArray(responses)) return "Answers must be a list.";
  if (responses.length > MAX_RESPONSES) {
    return `A lesson run-through can hold at most ${MAX_RESPONSES} answers.`;
  }
  for (const response of responses) {
    if (!response || typeof response !== "object") {
      return "Each answer must be an object.";
    }
    if (typeof response.answer !== "string") {
      return "Each answer must be text.";
    }
    if (response.answer.length > MAX_RESPONSE_LENGTH) {
      return `Answers are limited to ${MAX_RESPONSE_LENGTH} characters.`;
    }
  }
  return null;
}
