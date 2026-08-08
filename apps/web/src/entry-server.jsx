// The app, rendered on the Worker.
//
// This is a second Vite entry (`vite build --ssr`, see vite.config.js) built for
// the workerd runtime, and it is deliberately *not* src/main.jsx. main.jsx does
// several things that only make sense in a browser and would throw here — it
// appends font <link>s to document.head, imports the stylesheet, registers a
// service worker and mounts a toaster. What the two share is the part that
// matters: the same components, the same providers, and the same
// @spelling-creator/core modules the browser calls.
//
// The Worker calls render() with data it has already fetched (see
// apps/api/src/routes/ssr.js) and streams the result into the built index.html.
// Nothing here fetches: the Worker owns the data so it can decide the response
// status before a single byte of HTML is committed.

import { StrictMode } from "react";
import { renderToReadableStream } from "react-dom/server.browser";
// v7 folded the old react-router-dom/server subpath into the main entry.
import { StaticRouter } from "react-router-dom";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { createInstance } from "i18next";
import { configureCore } from "@spelling-creator/core/config";
import { baseConfig } from "./lib/i18n.js";
import App from "./App.jsx";
import { AuthProvider } from "./lib/auth.jsx";
import { ColorSchemeProvider } from "./lib/colorScheme.jsx";
import { TooltipProvider } from "./components/ui/tooltip.jsx";
import { Toaster } from "./components/ui/sonner.jsx";
import DisplayNameGate from "./components/DisplayNameGate.jsx";
import { SsrProvider } from "./lib/ssr.jsx";

// One instance per render rather than the shared default from lib/i18n.js:
// module scope in a Worker is per-isolate and shared by concurrent requests, so
// a mutable singleton would let one request's language settings affect
// another's. Only English ships today, which is also what the client's detector
// resolves to, so the hydrated text matches.
// `init()` returns a promise, but it is not awaited and does not need to be:
// every namespace is compiled into the bundle (see lib/i18n.js), and with inline
// resources and no backend i18next initialises synchronously — `isInitialized`
// is already true when this returns. `initImmediate: false` pins that down, so
// adding a backend later fails loudly here rather than silently rendering
// missing-key fallbacks into the served HTML.
function serverI18n() {
  const instance = createInstance();
  instance
    .use(initReactI18next)
    .init({ ...baseConfig, lng: "en", initImmediate: false });
  return instance;
}

// React emits hoisted document metadata — the `<title>` and `<meta>` tags
// DocumentMeta renders — ahead of everything else in the output, because this
// renders an app subtree rather than a whole <html> document. They have to be
// lifted into the real <head>: a scraper will not read an og: tag it finds in
// the body. Everything after this run of tags is the app's own markup.
const HOISTED_HEAD =
  /^(?:<title[^>]*>[\s\S]*?<\/title>|<(?:meta|link)\b[^>]*?\/?>)+/;

/**
 * Render one request into the two pieces the Worker has to place separately.
 *
 * @param {object} opts
 * @param {string} opts.url       Full request URL.
 * @param {object} opts.config    The same values main.jsx passes to configureCore.
 * @param {object} opts.data      Page payload, keyed as the pages expect it
 *                                ("lesson" | "lessons" | "profile").
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{head: string, body: string}>} `head` goes inside <head>,
 *   `body` inside <div id="root">.
 */
export async function render({ url, config, data, signal }) {
  // Same seam the browser uses — core reads its configuration through this
  // rather than touching import.meta.env, which is exactly what makes it
  // callable from here at all. See packages/core/src/config.js.
  configureCore(config);

  const { origin, pathname } = new URL(url);

  const stream = await renderToReadableStream(
    <StrictMode>
      <ColorSchemeProvider>
        <TooltipProvider>
          <StaticRouter location={pathname}>
            <I18nextProvider i18n={serverI18n()}>
              <SsrProvider bootstrap={{ path: pathname, data }} origin={origin}>
                {/* AuthProvider renders signed-out here: the session lives in
                    localStorage behind PKCE and is invisible to a server, which
                    is the whole reason only public reads are rendered. The
                    personalised chrome fills in when the client hydrates. */}
                <AuthProvider>
                  <DisplayNameGate>
                    <App />
                  </DisplayNameGate>
                </AuthProvider>
              </SsrProvider>
            </I18nextProvider>
          </StaticRouter>
          {/* Sonner renders a real (empty) <section> even with no toasts, so it
              has to be here too or the client would hydrate against markup that
              is one element short. ServiceWorkerPrompt, by contrast, renders
              null and is browser-only, so it is left out. */}
          <Toaster />
        </TooltipProvider>
      </ColorSchemeProvider>
    </StrictMode>,
    {
      signal,
      // Any error thrown while streaming is the Worker's to handle — it logs
      // and falls back to the static shell. Returning a digest keeps React from
      // writing the message into the response.
      onError(error) {
        console.error("SSR render error", error);
        return "ssr-error";
      },
    },
  );

  // Buffered rather than streamed. These pages are a single fetch's worth of
  // already-resolved data with no Suspense boundary to stream *into*, so there
  // is nothing to overlap — and having the whole document lets the Worker settle
  // the status code, and lift the metadata into the real <head>, before it
  // commits a byte.
  //
  // Read the stream rather than awaiting `stream.allReady` first: React's web
  // stream is pull-based, so nothing is produced until a consumer pulls, and
  // waiting on allReady with no reader attached deadlocks. Draining it to text
  // gives the same "everything is here" guarantee.
  const html = await new Response(stream).text();

  const hoisted = html.match(HOISTED_HEAD);
  return {
    head: hoisted ? hoisted[0] : "",
    body: hoisted ? html.slice(hoisted[0].length) : html,
  };
}
