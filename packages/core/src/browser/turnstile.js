// Helpers around the Cloudflare Turnstile browser widget.
//
// The widget is loaded via the explicit-render script in index.html. We expose
// the public site key and a small promise that resolves once `window.turnstile`
// is available, so components can render a widget as soon as the script loads.
//
// The site key itself comes from the config seam (`turnstileSiteKey()`), not a
// build-time constant — see ../config.js.

let readyPromise = null;

/**
 * Resolves with the global `turnstile` object once the script has loaded.
 * Rejects if it has not appeared within `timeoutMs`.
 */
export function whenTurnstileReady(timeoutMs = 10000) {
  if (typeof window !== "undefined" && window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (!readyPromise) {
    readyPromise = new Promise((resolve, reject) => {
      let waited = 0;
      const timer = setInterval(() => {
        if (window.turnstile) {
          clearInterval(timer);
          resolve(window.turnstile);
        } else if ((waited += 100) >= timeoutMs) {
          clearInterval(timer);
          readyPromise = null; // allow a later retry
          reject(new Error("Turnstile failed to load. Check your connection."));
        }
      }, 100);
    });
  }
  return readyPromise;
}
