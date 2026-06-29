// The homepage hero's animated backdrop: spelling words drifting upward, with
// fresh words continually emitted from the bottom edge. Words are the real ones
// taught across the hub's published lessons (fetched from the Worker's cached
// /spelling-words.json — see lib/spellingWords.js).
//
// Built on tsParticles (v4) via its React binding. The engine is initialised
// once for the whole app through <ParticlesProvider>, whose `init` callback must
// be a stable module-level reference (the provider throws if it changes between
// renders) — hence `initEngine` lives at module scope. We load only the slim
// preset plus the two extra plugins this effect needs: the "text" shape (renders
// each particle as a word) and the emitters plugin (spawns words at the bottom).

import { useEffect, useMemo, useState } from "react";
import Particles, { ParticlesProvider } from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";
import { loadTextShape } from "@tsparticles/shape-text";
import { loadEmittersPlugin } from "@tsparticles/plugin-emitters";
import { fetchSpellingWords } from "../lib/spellingWords.js";

// Register exactly the features the hero uses. Must stay a single stable
// reference for the lifetime of the app (see file header).
async function initEngine(engine) {
  await loadSlim(engine);
  await loadTextShape(engine);
  await loadEmittersPlugin(engine);
}

// Soft, light tints that read against the hero's dark gradient.
const WORD_COLORS = ["#ffffff", "#dbe4ff", "#bac8ff", "#eebefa", "#d0bfff"];

// A row of launch points spread evenly across the bottom edge, so words rise
// from many places rather than one. Each is a near-point emitter; together they
// keep a dense, well-distributed field of words in the air at once.
const EMITTER_COUNT = 9;
const EMITTERS = Array.from({ length: EMITTER_COUNT }, (_, i) => ({
  direction: "top",
  // Evenly spaced across the width (inset slightly from the edges).
  position: { x: 6 + (88 * i) / (EMITTER_COUNT - 1), y: 101 },
  // A small spawn patch around each point so adjacent launches don't overlap.
  size: { width: 8, height: 0, mode: "percent" },
  rate: { delay: 0.9, quantity: 1 },
  life: { count: 0 }, // emit forever
}));

/**
 * Build the tsParticles config from the resolved word list. The text shape sizes
 * each word from the particle's `size` (font px ≈ 2·size / wordLength), so the
 * size range keeps even long words legible. Particles move straight up and are
 * destroyed at the top; a row of emitters along the bottom edge keeps spawning
 * new ones from many points, so the field reads as a crowd of words rising and
 * being replaced from below.
 */
function buildOptions(words) {
  return {
    fullScreen: { enable: false }, // stay inside the hero box, not the viewport
    detectRetina: true,
    fpsLimit: 60,
    background: { color: "transparent" },
    // No initial field — every word originates from the bottom emitters below.
    particles: {
      number: { value: 0 },
      color: { value: WORD_COLORS },
      shape: {
        type: "text",
        options: {
          text: {
            value: words,
            font: 'Roboto, "Helvetica Neue", Arial, sans-serif',
            weight: "700",
            style: "",
          },
        },
      },
      opacity: {
        value: { min: 0.3, max: 0.8 },
      },
      // Smaller than before so many words fit side by side without crowding.
      size: {
        value: { min: 26, max: 64 },
      },
      move: {
        enable: true,
        direction: "top",
        straight: false,
        random: false,
        // A slower drift means each word lingers longer, so more are on screen
        // at any moment.
        speed: { min: 0.4, max: 1.3 },
        // Rising words leave at the top and are removed; the emitters replace
        // them from the bottom, so the population stays steady.
        outModes: { default: "destroy", bottom: "none" },
      },
    },
    emitters: EMITTERS,
  };
}

export default function FloatingWords() {
  const [words, setWords] = useState(null);

  useEffect(() => {
    let active = true;
    fetchSpellingWords().then((list) => {
      if (active) setWords(list);
    });
    return () => {
      active = false;
    };
  }, []);

  const options = useMemo(() => (words ? buildOptions(words) : null), [words]);

  // Wait for the words before mounting the engine so the first emitted particles
  // already carry the real list (rebuilding options would otherwise reload the
  // whole container). The provider renders its child only once the engine is ready.
  if (!options) return null;

  return (
    <ParticlesProvider init={initEngine}>
      <Particles
        id="floating-words"
        options={options}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      />
    </ParticlesProvider>
  );
}
