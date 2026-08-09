// Text-to-speech over the Web Speech API (`window.speechSynthesis`), used by
// interactive mode to read each step aloud.
//
// Everything here runs on the reader's own device — like the on-device lesson
// summaries, no Worker call, no cost, and the lesson text never leaves the
// machine. The API ships in every current browser, but it is still probed rather
// than assumed: where it's missing the hook reports `supported: false` and the
// UI hides the controls entirely instead of offering a button that can't work.
//
// Three quirks of the platform shape this file:
//
//   Voices load late. `getVoices()` returns [] on first call in most browsers
//   and fills in asynchronously, announced by a `voiceschanged` event. So the
//   list is state, populated from both.
//
//   Long utterances get cut off. Chromium stops speaking after ~15 seconds of a
//   single utterance. Splitting the text into sentence-sized chunks and queueing
//   them keeps every individual utterance well under that, which also makes
//   `cancel()` feel instant.
//
//   Cancelling is not synchronous. `cancel()` then an immediate `speak()` can
//   drop the new utterance in Chromium, so speaking is deferred a tick after a
//   cancel.
//
// The user's preferences (on/off, voice, rate) are persisted, so someone who
// needs speech doesn't re-enable it on every lesson.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ENABLED_KEY = "spelling-creator:tts-enabled";
const VOICE_KEY = "spelling-creator:tts-voice";
const RATE_KEY = "spelling-creator:tts-rate";

/** Speaking rates offered in the UI. 1 is the browser's normal pace. */
export const SPEECH_RATES = [0.7, 0.85, 1, 1.25, 1.5];
export const DEFAULT_SPEECH_RATE = 1;

// Longest chunk we hand to a single utterance. Short enough to stay clear of
// Chromium's ~15s cutoff at the slowest rate we offer, long enough that a normal
// sentence is spoken as one unit with its natural intonation.
const MAX_CHUNK = 180;

function readStored(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored;
  } catch {
    // localStorage unavailable (private browsing, etc.) — use the default.
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not being able to remember the preference is not worth failing over.
  }
}

/**
 * Split text into utterance-sized chunks: first by line (the caller composes one
 * idea per line — see stepSpeechText in core/interactive.js), then by sentence,
 * then, only if a single sentence is still enormous, on whitespace. Chunking on
 * punctuation rather than a raw character count matters: a cut mid-clause is
 * audible as a wrong-sounding pause.
 * @param {string} text
 * @returns {string[]}
 */
export function chunkForSpeech(text) {
  const chunks = [];

  for (const line of (text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length <= MAX_CHUNK) {
      chunks.push(trimmed);
      continue;
    }
    // Keep the terminator with the sentence it ends, so the voice still falls at
    // a full stop and rises at a question mark.
    for (const sentence of trimmed.match(/[^.!?]+[.!?]*\s*/g) || [trimmed]) {
      const part = sentence.trim();
      if (!part) continue;
      if (part.length <= MAX_CHUNK) {
        chunks.push(part);
        continue;
      }
      let buffer = "";
      for (const word of part.split(/\s+/)) {
        if (buffer && `${buffer} ${word}`.length > MAX_CHUNK) {
          chunks.push(buffer);
          buffer = word;
        } else {
          buffer = buffer ? `${buffer} ${word}` : word;
        }
      }
      if (buffer) chunks.push(buffer);
    }
  }

  return chunks;
}

/**
 * Speech synthesis for the current browser, with the user's remembered
 * preferences.
 *
 * @returns {{
 *   supported: boolean,
 *   enabled: boolean, setEnabled: (on: boolean) => void,
 *   speaking: boolean,
 *   speak: (text: string) => void,
 *   stop: () => void,
 *   voices: SpeechSynthesisVoice[],
 *   voiceURI: string, setVoiceURI: (uri: string) => void,
 *   rate: number, setRate: (rate: number) => void,
 * }}
 */
export function useSpeech() {
  // Probed in an effect, not at render: the server has no `window`, and a
  // hydrating client has to render the same markup the server sent.
  const [supported, setSupported] = useState(false);
  const [voices, setVoices] = useState([]);
  const [speaking, setSpeaking] = useState(false);

  // Preferences also start at their defaults and adopt the stored values after
  // mount, for the same hydration reason.
  const [enabled, setEnabledState] = useState(false);
  const [voiceURI, setVoiceURIState] = useState("");
  const [rate, setRateState] = useState(DEFAULT_SPEECH_RATE);

  // The utterances we queued, so `stop()` can tell "the user cancelled" apart
  // from "it finished on its own" — a cancel fires `onend` for every queued
  // utterance, and without this the speaking flag flickers.
  const generation = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis)
      return undefined;
    setSupported(true);

    setEnabledState(readStored(ENABLED_KEY, "") === "true");
    setVoiceURIState(readStored(VOICE_KEY, ""));
    const storedRate = Number(readStored(RATE_KEY, ""));
    if (SPEECH_RATES.includes(storedRate)) setRateState(storedRate);

    const synth = window.speechSynthesis;
    const readVoices = () => setVoices(synth.getVoices() || []);
    readVoices();
    synth.addEventListener("voiceschanged", readVoices);

    return () => {
      synth.removeEventListener("voiceschanged", readVoices);
      // Leaving the page mid-sentence should not leave a voice talking over
      // whatever the user does next: speechSynthesis is global to the tab and
      // outlives this component.
      synth.cancel();
    };
  }, []);

  const setEnabled = useCallback((next) => {
    setEnabledState(next);
    writeStored(ENABLED_KEY, next ? "true" : "false");
    if (!next && typeof window !== "undefined" && window.speechSynthesis) {
      generation.current += 1;
      window.speechSynthesis.cancel();
      setSpeaking(false);
    }
  }, []);

  const setVoiceURI = useCallback((next) => {
    setVoiceURIState(next);
    writeStored(VOICE_KEY, next);
  }, []);

  const setRate = useCallback((next) => {
    setRateState(next);
    writeStored(RATE_KEY, String(next));
  }, []);

  const stop = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    generation.current += 1;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      const chunks = chunkForSpeech(text);
      if (chunks.length === 0) return;

      const synth = window.speechSynthesis;
      generation.current += 1;
      const mine = generation.current;
      synth.cancel();

      // `cancel()` isn't synchronous in Chromium — speaking in the same tick can
      // be swallowed by the cancellation that's still settling.
      setTimeout(() => {
        if (generation.current !== mine) return;
        const voice = (synth.getVoices() || []).find(
          (candidate) => candidate.voiceURI === voiceURI,
        );
        chunks.forEach((chunk, index) => {
          const utterance = new SpeechSynthesisUtterance(chunk);
          if (voice) {
            utterance.voice = voice;
            // Some engines ignore `voice` unless the language agrees with it.
            utterance.lang = voice.lang;
          }
          utterance.rate = rate;
          if (index === chunks.length - 1) {
            // Only the last chunk ends the run. A cancel bumps the generation,
            // so the stale utterances it flushes don't clear a newer run's flag.
            const finish = () => {
              if (generation.current === mine) setSpeaking(false);
            };
            utterance.onend = finish;
            utterance.onerror = finish;
          } else {
            utterance.onerror = () => {
              if (generation.current === mine) setSpeaking(false);
            };
          }
          synth.speak(utterance);
        });
        setSpeaking(true);
      }, 0);
    },
    [rate, voiceURI],
  );

  return useMemo(
    () => ({
      supported,
      enabled,
      setEnabled,
      speaking,
      speak,
      stop,
      voices,
      voiceURI,
      setVoiceURI,
      rate,
      setRate,
    }),
    [
      supported,
      enabled,
      setEnabled,
      speaking,
      speak,
      stop,
      voices,
      voiceURI,
      setVoiceURI,
      rate,
      setRate,
    ],
  );
}
