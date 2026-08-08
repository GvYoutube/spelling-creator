// The seam between a server-rendered page and the client that hydrates it.
//
// Three of the public routes (/hub, /hub/:id, /users/:id) are rendered on the
// Worker before the browser has any JavaScript — see apps/api/src/routes/ssr.js.
// The server fetches the page's data, renders the React tree with it, and
// serialises the same data into the HTML as `window.__SSR__`. The client picks
// it up here so hydration renders exactly what the server did, and so the page
// doesn't immediately re-fetch what it was just handed.
//
// Everything is passed through context rather than read from a module-level
// variable, because the same module runs inside the Worker: module scope there
// is per-isolate and shared by concurrent requests, so per-request state kept
// there would leak between visitors.

import { createContext, useContext, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * @typedef {object} Bootstrap
 * @property {string} path  Pathname the server rendered. Data is only handed to
 *   a page whose current route still matches it.
 * @property {Record<string, unknown>} data  Per-page payload, keyed by the name
 *   the page asks for (e.g. "lesson", "lessons", "profile").
 */

// Holds a mutable box, not the payload itself. Releasing the payload after
// hydration is then a mutation rather than a state change, so it costs nothing
// — swapping a context *value* would re-render the entire tree for no benefit.
const BootstrapContext = createContext(null);

// Site origin ("https://spellingcreator.org"). The browser has window.location;
// the Worker does not, so it passes the request's origin down instead. Used for
// canonical/og:url and for absolute URLs inside JSON-LD.
const OriginContext = createContext("");

/**
 * Wraps the app in both contexts. `bootstrap` is null on a normally-loaded SPA
 * page and on every client-side navigation after the first.
 */
export function SsrProvider({ bootstrap = null, origin = "", children }) {
  const box = useRef(bootstrap);
  const { pathname } = useLocation();

  // Release the payload when the app navigates away from the path the server
  // rendered, so coming back later re-fetches instead of re-displaying what the
  // server sent minutes ago.
  //
  // Keyed on navigation and not on "we have mounted", which was the first
  // attempt and is wrong: App.jsx puts the routes behind a <Suspense>, and
  // React commits the tree *outside* a suspense boundary — running this
  // provider's effects — before it hydrates the boundary's contents. A page
  // inside it therefore renders after the mount effect, and would have found
  // the payload already gone.
  useEffect(() => {
    if (box.current && box.current.path !== pathname) box.current = null;
  }, [pathname]);

  return (
    <OriginContext value={origin}>
      <BootstrapContext value={box}>{children}</BootstrapContext>
    </OriginContext>
  );
}

/**
 * The server-rendered payload for this page, or undefined when there isn't one
 * — which is the normal case: a client-side navigation, a route the Worker
 * doesn't server-render, or any load after hydration has finished.
 *
 * Pages use it as a starting value, never as a substitute for being able to
 * fetch: `useState(useServerData("lesson") ?? null)`.
 *
 * @param {string} key
 */
export function useServerData(key) {
  const box = useContext(BootstrapContext);
  const { pathname } = useLocation();
  const bootstrap = box?.current;
  if (!bootstrap || bootstrap.path !== pathname) return undefined;
  return bootstrap.data?.[key];
}

/** The site origin, safe to call during a server render. */
export function useSiteOrigin() {
  return useContext(OriginContext);
}
