// Saves the generated .docx to the signed-in user's Google Drive, converting it
// to native Google Docs format on upload.
//
// This is a purely client-side flow using Google Identity Services (GIS):
//   1. GIS issues a short-lived OAuth2 access token (implicit token flow) scoped
//      to `drive.file` — the app can only touch files it created, never the
//      user's existing Drive contents.
//   2. We upload the docx via the Drive multipart upload endpoint, asking Drive
//      to store it as `application/vnd.google-apps.document` so it is converted
//      to a Google Doc on the way in.
//
// Requires VITE_GOOGLE_CLIENT_ID to be set to an OAuth 2.0 Web client ID whose
// "Authorised JavaScript origins" include the site's origin.

import { Packer } from "docx";
import { buildDocument } from "./docxExport.js";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

// Only request access to files this app creates — the least-privileged Drive scope.
const SCOPE = "https://www.googleapis.com/auth/drive.file";

const UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const GDOC_MIME = "application/vnd.google-apps.document";

// --- Rate-limit / quota safety ---------------------------------------------
// Drive enforces a per-user request quota. To stay within it we (a) only ever
// keep one upload in flight at a time, (b) refuse uploads fired closer together
// than MIN_INTERVAL_MS, and (c) honour Drive's own back-pressure by retrying
// transient quota errors with exponential backoff (respecting any Retry-After).
const MIN_INTERVAL_MS = 2000; // minimum gap between two successful upload starts
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 32000;

// HTTP statuses worth retrying after a delay.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// 403 reasons that are transient rate limiting (vs. hard quota like storage full).
const RETRYABLE_403_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

let tokenClient = null;
let inFlight = false; // guards against concurrent uploads
let lastUploadAt = 0; // timestamp of the last upload start, for throttling

/**
 * Resolves with `google.accounts.oauth2` once the GIS script has loaded.
 * Rejects if it has not appeared within `timeoutMs`.
 */
function whenGisReady(timeoutMs = 10000) {
  const ready = () => window.google?.accounts?.oauth2;
  if (typeof window !== "undefined" && ready()) {
    return Promise.resolve(window.google.accounts.oauth2);
  }
  return new Promise((resolve, reject) => {
    let waited = 0;
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve(window.google.accounts.oauth2);
      } else if ((waited += 100) >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Google sign-in failed to load. Check your connection."));
      }
    }, 100);
  });
}

/**
 * Requests an OAuth2 access token, prompting the user to sign in / consent if
 * needed. Resolves with the access token string.
 */
async function getAccessToken() {
  if (!CLIENT_ID) {
    throw new Error(
      "Google saving is not configured (VITE_GOOGLE_CLIENT_ID is missing).",
    );
  }
  const oauth2 = await whenGisReady();

  if (!tokenClient) {
    tokenClient = oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      // Callbacks are (re)assigned per request below.
      callback: () => {},
    });
  }

  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new Error(response.error_description || response.error));
        return;
      }
      resolve(response.access_token);
    };
    tokenClient.error_callback = (err) => {
      reject(new Error(err?.message || "Google sign-in was cancelled."));
    };
    // Empty prompt reuses an existing grant when possible, only showing the
    // consent screen the first time.
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

// Google Doc title — the Drive UI shows this; no file extension needed.
function driveDocName(title) {
  return (title || "").trim() || "Untitled Lesson";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Inspect a failed response and decide whether (and how long) to wait before a
// retry. Returns { retry: boolean, delayMs: number, message: string }.
async function classifyFailure(res, attempt) {
  const text = await res.text().catch(() => "");
  let reason = "";
  let message = text;
  try {
    const err = JSON.parse(text)?.error;
    reason = err?.errors?.[0]?.reason || err?.status || "";
    message = err?.message || text;
  } catch {
    /* non-JSON error body — keep raw text */
  }

  const retryable =
    RETRYABLE_STATUS.has(res.status) ||
    (res.status === 403 && RETRYABLE_403_REASONS.has(reason));

  // Prefer the server's own Retry-After hint when present.
  let delayMs = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) delayMs = secs * 1000;
  }
  // Add jitter so simultaneous clients don't retry in lockstep.
  delayMs += Math.floor(Math.random() * 1000);

  return { retry: retryable, delayMs, reason, message };
}

// POST the multipart body, retrying transient quota / rate-limit errors with
// exponential backoff so we never keep hammering the API past its quota.
async function uploadWithBackoff(body, token) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    });

    if (res.ok) return res.json();

    const { retry, delayMs, reason, message } = await classifyFailure(
      res,
      attempt,
    );
    lastErr = new Error(
      `Drive upload failed (${res.status}${reason ? ` ${reason}` : ""}). ${message}`.trim(),
    );

    if (!retry || attempt === MAX_ATTEMPTS - 1) throw lastErr;
    await sleep(delayMs);
  }
  throw lastErr;
}

/**
 * Builds the lesson docx and uploads it to the user's Drive as a Google Doc.
 * @param {object} doc  The lesson document state.
 * @returns {Promise<{id: string, name: string, webViewLink: string}>}
 */
export async function saveToGoogleDrive(doc) {
  // Never allow two uploads at once — a second click while one is running would
  // double our request rate for no benefit.
  if (inFlight) {
    throw new Error("A save is already in progress. Please wait for it to finish.");
  }

  // Throttle: refuse uploads fired closer together than MIN_INTERVAL_MS.
  const since = Date.now() - lastUploadAt;
  if (since < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - since) / 1000);
    throw new Error(`Please wait ${wait}s before saving to Google again.`);
  }

  inFlight = true;
  lastUploadAt = Date.now();
  try {
    const token = await getAccessToken();

    const document = buildDocument(doc);
    const docxBlob = await Packer.toBlob(document);

    const metadata = {
      name: driveDocName(doc.title),
      mimeType: GDOC_MIME, // convert the uploaded docx to a native Google Doc
    };

    const boundary = "spelling-lesson-maker-boundary";
    const body = new Blob(
      [
        `--${boundary}\r\n`,
        "Content-Type: application/json; charset=UTF-8\r\n\r\n",
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\n`,
        `Content-Type: ${DOCX_MIME}\r\n\r\n`,
        docxBlob,
        `\r\n--${boundary}--`,
      ],
      { type: `multipart/related; boundary=${boundary}` },
    );

    return await uploadWithBackoff(body, token);
  } finally {
    inFlight = false;
  }
}

// Whether the Google integration is configured at build time.
export const googleDriveEnabled = Boolean(CLIENT_ID);
