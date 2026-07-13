// On-device lesson summaries via the browser's Summarizer API.
//
// Unlike the other AI helpers in this app (aiSuggest.js), nothing here talks to
// the Worker: no Turnstile, no API key, no network round-trip. The browser runs a
// local model, so a summary costs us nothing and the lesson text never leaves the
// machine. The trade-off is that the API barely exists yet — it's Chromium-only,
// desktop-only, and gated behind hardware minimums (free disk space, VRAM, an
// unmetered connection for the one-time model download). Most visitors can't use
// it, and the ones who can may need to download the model first.
//
// So every entry point here FAILS CLOSED: if the API is missing, the options
// aren't supported, or the availability probe itself throws, we report
// "unavailable" rather than surfacing an error. The UI (LessonSummary.jsx) then
// renders nothing at all, and a browser without the API simply never sees the
// feature instead of seeing a button that breaks.
//
// Spec: https://developer.mozilla.org/en-US/docs/Web/API/Summarizer_API

/**
 * The summary shapes the spec defines, in the order the UI offers them.
 * "key-points" (a bulleted list) is the default: it's the most useful read for a
 * teacher scanning a lesson, and it's what the API itself defaults to.
 */
export const SUMMARY_TYPES = [
  { value: "key-points", label: "Key points" },
  { value: "tldr", label: "TL;DR" },
  { value: "teaser", label: "Teaser" },
  { value: "headline", label: "Headline" },
];

/** The spec's `length` values — relative, not a word count. */
export const SUMMARY_LENGTHS = [
  { value: "short", label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "long", label: "Long" },
];

export const DEFAULT_SUMMARY_TYPE = "key-points";
export const DEFAULT_SUMMARY_LENGTH = "short";

// Steers the model: without it, a lesson full of question prompts and word lists
// reads like a worksheet to summarise rather than a lesson to describe.
const SHARED_CONTEXT =
  "A spelling and literacy lesson written by a teacher, containing lesson text, " +
  "practice questions and spelling word lists. Summarise it for another teacher " +
  "deciding whether the lesson suits their class.";

// Below this, a lesson has less text than the summary would, so we don't offer
// one — the feature is hidden rather than producing a summary longer than the
// thing it summarises.
export const MIN_SUMMARY_CHARS = 400;

// The API is exposed as a `Summarizer` global. Reach it through `globalThis` so
// this module is safe to import anywhere (and so a bare undeclared global never
// throws a ReferenceError on browsers that don't ship it).
function summarizerApi() {
  return globalThis.Summarizer;
}

/** Does this browser expose the Summarizer API at all? */
export function summarizerSupported() {
  return Boolean(summarizerApi());
}

// The options passed to both availability() and create(). We deliberately leave
// the language options (expectedInputLanguages / outputLanguage) unset: naming a
// language the local model doesn't have makes create() throw NotSupportedError,
// whereas leaving them out lets the browser detect the lesson's language and
// answer in it.
function summarizerOptions({ type, length }) {
  return {
    type: type || DEFAULT_SUMMARY_TYPE,
    length: length || DEFAULT_SUMMARY_LENGTH,
    format: "markdown",
    sharedContext: SHARED_CONTEXT,
  };
}

/**
 * Can this browser summarise with these options, and is the model ready?
 *
 * @param {{type?: string, length?: string}} [options]
 * @returns {Promise<"available"|"downloadable"|"downloading"|"unavailable">}
 *   "available"   — ready to run now.
 *   "downloadable"— supported, but the first run downloads the model.
 *   "downloading" — supported, and a download is already in flight.
 *   "unavailable" — no API, unsupported options, or hardware below the minimums.
 */
export async function summarizerAvailability(options = {}) {
  const api = summarizerApi();
  if (!api) return "unavailable";
  try {
    return (
      (await api.availability(summarizerOptions(options))) || "unavailable"
    );
  } catch {
    // A probe that throws means we can't use it — same outcome as "no".
    return "unavailable";
  }
}

/**
 * Create a Summarizer session.
 *
 * Must be called from a user gesture (a click): the spec requires transient
 * activation, so this can't be kicked off from an effect on page load.
 *
 * @param {{type?: string, length?: string}} options
 * @param {object} [hooks]
 * @param {AbortSignal} [hooks.signal]  Aborts creation (and any model download).
 * @param {(loaded: number) => void} [hooks.onDownloadProgress]  Download fraction, 0–1.
 * @returns {Promise<object>} The Summarizer session. Call `.destroy()` when done.
 */
export async function createSummarizer(options = {}, hooks = {}) {
  const api = summarizerApi();
  if (!api) throw new Error("This browser can't summarise on-device.");

  return api.create({
    ...summarizerOptions(options),
    signal: hooks.signal,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        hooks.onDownloadProgress?.(event.loaded);
      });
    },
  });
}

/**
 * Stream a summary of `text`, yielding each chunk as the model produces it, so
 * the UI can render the summary as it's written instead of after it's finished.
 *
 * @param {object} summarizer  A session from createSummarizer().
 * @param {string} text
 * @param {{signal?: AbortSignal}} [options]
 * @returns {AsyncIterable<string>} Successive chunks — concatenate them.
 */
export function summarizeStream(summarizer, text, options = {}) {
  return summarizer.summarizeStreaming(text, { signal: options.signal });
}

/**
 * Trim `text` to the session's input budget.
 *
 * The model can only take so much input (`inputQuota`, in the same opaque units
 * measureInputUsage() reports); a long lesson can exceed it, and summarize() then
 * throws QuotaExceededError. Usage tracks length closely enough that scaling the
 * text down by the overshoot ratio (with headroom) converges in a couple of
 * passes, so we cut the tail rather than fail — a summary of most of the lesson
 * beats no summary. The caller tells the reader when we've had to cut.
 *
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
export async function fitToQuota(summarizer, text) {
  const quota = summarizer.inputQuota;
  if (
    typeof summarizer.measureInputUsage !== "function" ||
    !Number.isFinite(quota)
  ) {
    return { text, truncated: false };
  }

  let candidate = text;
  // Bounded: each pass shrinks the text, and in practice one or two suffice.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let usage;
    try {
      usage = await summarizer.measureInputUsage(candidate);
    } catch {
      // Can't measure — hand it over as-is and let summarize() decide.
      return { text: candidate, truncated: candidate.length < text.length };
    }
    if (!(usage > quota) || !usage) {
      return { text: candidate, truncated: candidate.length < text.length };
    }
    const ratio = (quota / usage) * 0.9; // 10% headroom
    const cut = Math.max(1, Math.floor(candidate.length * ratio));
    candidate = candidate.slice(0, cut);
  }
  return { text: candidate, truncated: true };
}

/**
 * The lesson document as the text we hand the model.
 *
 * This is deliberately NOT `lessonPlainText()` (LessonView.jsx), which flattens a
 * lesson into prose for a meta description. Here the structure is the point: the
 * title and section headings tell the model how the lesson is organised, and
 * labelling the questions and word lists stops a bare list of words reading as
 * body text. Image captions stay out — they're usually attribution boilerplate.
 *
 * @param {object} doc  The lesson body: { title, sections: [{ name, blocks }] }.
 * @returns {string} Markdown-ish plain text in reading order.
 */
export function lessonSummaryText(doc) {
  const parts = [];
  if (doc?.title) parts.push(`# ${doc.title}`);

  for (const section of doc?.sections || []) {
    if (section.name) parts.push(`## ${section.name}`);
    for (const block of section.blocks || []) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      } else if (block.type === "question" && block.prompt) {
        parts.push(`Question: ${block.prompt}`);
      } else if (block.type === "spelling") {
        const words = (block.words || [])
          .map((word) => (word.text || "").trim())
          .filter(Boolean);
        if (words.length) parts.push(`Spelling words: ${words.join(", ")}`);
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * A message worth showing a reader, given whatever create()/summarize() threw.
 * The spec's DOMException names are the useful signal here; everything else falls
 * back to a generic line rather than leaking an internal message.
 */
export function summarizerErrorMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
      return "Summarising is blocked on this page.";
    case "NotSupportedError":
      return "This lesson's language isn't supported by the on-device model.";
    case "QuotaExceededError":
      return "This lesson is too long for the on-device model.";
    case "NetworkError":
      return "The model download didn't finish. Check your connection and try again.";
    case "UnknownError":
    case "OperationError":
      return "The on-device model couldn't summarise this lesson. Try again.";
    default:
      return "Couldn't summarise this lesson.";
  }
}
