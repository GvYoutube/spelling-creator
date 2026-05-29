// Calls the spelling-creator-cf Worker to generate suggested lesson text.
//
// The Worker validates the Turnstile token server-side (verifying both that the
// challenge passed and that it was solved on an allowed domain) before doing any
// AI work, so every request must carry a fresh token.

const API_URL = import.meta.env.VITE_API_URL;

/**
 * Ask the Worker for a block of text about `subject`.
 * @param {string} subject  Topic to write about.
 * @param {string} token    Turnstile token from the widget's callback.
 * @param {object} [context]  Extra context to help the model.
 * @param {string} [context.documentName]  Title of the overall lesson/document.
 * @returns {Promise<string>} The generated text.
 */
export async function suggestText(subject, token, context = {}) {
  if (!API_URL) {
    throw new Error("VITE_API_URL is not configured.");
  }
  if (!token) {
    throw new Error("Please complete the verification challenge first.");
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject,
        token,
        documentName: context.documentName || "",
      }),
    });
  } catch (e) {
    throw new Error("Could not reach the suggestion service.");
  }

  if (!res.ok) {
    // The Worker returns a plain-text reason for 4xx/5xx (e.g. rate limit,
    // failed verification). Surface it directly when present.
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status}).`);
  }

  const data = await res.json().catch(() => ({}));
  return data.text || "";
}

/**
 * Ask the Worker to suggest a quiz question about `subject`.
 * @param {string} subject  Topic for the question (the section title).
 * @param {string} token    Turnstile token from the widget's callback.
 * @param {object} [context]  Extra context to help the model.
 * @param {string} [context.questionType]  One of the question type keys (default "single").
 * @param {string} [context.documentName]  Title of the overall lesson/document.
 * @param {string} [context.sectionText]   Existing section text to ground the question in.
 * @returns {Promise<object>} The suggested question data (shape depends on type).
 */
export async function suggestQuestion(subject, token, context = {}) {
  if (!API_URL) {
    throw new Error("VITE_API_URL is not configured.");
  }
  if (!token) {
    throw new Error("Please complete the verification challenge first.");
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "question",
        subject,
        token,
        questionType: context.questionType || "single",
        documentName: context.documentName || "",
        sectionText: context.sectionText || "",
      }),
    });
  } catch (e) {
    throw new Error("Could not reach the suggestion service.");
  }

  if (!res.ok) {
    // The Worker returns a plain-text reason for 4xx/5xx (e.g. rate limit,
    // failed verification). Surface it directly when present.
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status}).`);
  }

  const data = await res.json().catch(() => ({}));
  return data.question || {};
}
