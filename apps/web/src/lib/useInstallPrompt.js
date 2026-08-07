// "Install app" affordance for the PWA (see src/lib/pwa.jsx for the service
// worker half).
//
// Chromium fires `beforeinstallprompt` when the app meets the installability
// criteria, and it fires *early* — typically before React has mounted. So the
// listener is registered at module scope, on import, and the captured event is
// held in a tiny store that components subscribe to. Calling preventDefault()
// is what stops the browser showing its own mini-infobar and lets us decide
// where the affordance lives (the header, next to the other nav actions).
//
// Safari has no such event: on iOS an app is installed through Share → "Add to
// Home Screen", and there is no API to trigger or even detect eligibility. We
// detect the browser instead and offer instructions, which is the only thing
// available there.

import { useCallback, useSyncExternalStore } from "react";

// The deferred `BeforeInstallPromptEvent`, or null. Single-valued: the browser
// fires at most one at a time, and a new one supersedes the old.
let deferred = null;
let installed = false;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// True once the app is running from the home screen / app shell rather than a
// browser tab, in which case there is nothing left to install. `standalone` is
// Safari's non-standard equivalent of the display-mode media query.
function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

// iOS Safari, where installing is a manual Share-sheet action. Every iOS
// browser is Safari under the skin, but only Safari's own UI has the "Add to
// Home Screen" item, so Chrome/Firefox/Edge on iOS are excluded — pointing
// someone at a menu entry their browser doesn't have is worse than silence.
function isIosSafari() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as a Mac; the touch points give it away.
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    emit();
  });
}

// getSnapshot must return a stable value for an unchanged store, so the two
// booleans are folded into one of three interned strings rather than a fresh
// object (which would re-render on every check).
function getSnapshot() {
  if (installed || isStandalone()) return "installed";
  if (deferred) return "prompt";
  return "none";
}

// The server/prerender snapshot: the Worker's headless-Chromium prerender runs
// this module too, and neither branch above is meaningful there.
function getServerSnapshot() {
  return "none";
}

/**
 * @returns {{
 *   canInstall: boolean,   // show the affordance at all
 *   needsManual: boolean,  // no API to call — show instructions instead
 *   install: () => Promise<boolean>,  // resolves true if the user accepted
 * }}
 */
export function useInstallPrompt() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const manual = state === "none" && isIosSafari() && !isStandalone();

  const install = useCallback(async () => {
    if (!deferred) return false;
    const event = deferred;
    // A deferred prompt is single-use: whether or not it's accepted, the
    // browser won't let us call prompt() on it again. Clear it first so a
    // double-click can't fire it twice.
    deferred = null;
    emit();
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      return outcome === "accepted";
    } catch {
      return false;
    }
  }, []);

  return {
    canInstall: state === "prompt" || manual,
    needsManual: manual,
    install,
  };
}
