import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { configureCore } from "@spelling-creator/core/config";

// Hand the shared package every piece of build-time configuration it needs,
// before anything reads it. `import.meta.env` is substituted by Vite and
// exists nowhere else, so core takes these through this seam rather than
// reaching for the bundler itself — see packages/core/src/config.js.
//
// This is now the ONLY place in the app that touches import.meta.env.
configureCore({
  apiUrl: import.meta.env.VITE_API_URL,
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  turnstileSiteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
  authMode: import.meta.env.VITE_AUTH_MODE,
  usernameDomain: import.meta.env.VITE_USERNAME_DOMAIN,
});
// Registers all translation namespaces with i18next before anything renders.
import "./lib/i18n.js";
// Tailwind + shadcn/ui tokens (full preflight now that MUI's CssBaseline is
// gone — see the comment at the top of globals.css). Imported once here so
// every component can use the utility classes and CSS variables.
import "./styles/globals.css";
// Self-hosted via Fontsource (loads faster than a Google Fonts CDN link —
// see the memory on this). Fraunces 600 is headings only; Public Sans
// 400/500/600 is UI/body text — see globals.css for where each is applied.
import "@fontsource/fraunces/600.css";
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/500.css";
import "@fontsource/public-sans/600.css";
// Preload the weights so the fonts are fetched in parallel with the bundle and
// are ready before first paint — avoids the flash of fallback (unstyled) text.
// Vite fingerprints these URLs at build time, so we resolve them via ?url
// rather than hardcoding hashed paths in index.html.
import fraunces600 from "@fontsource/fraunces/files/fraunces-latin-600-normal.woff2?url";
import publicSans400 from "@fontsource/public-sans/files/public-sans-latin-400-normal.woff2?url";
import publicSans500 from "@fontsource/public-sans/files/public-sans-latin-500-normal.woff2?url";
import publicSans600 from "@fontsource/public-sans/files/public-sans-latin-600-normal.woff2?url";

for (const href of [fraunces600, publicSans400, publicSans500, publicSans600]) {
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "font";
  link.type = "font/woff2";
  link.href = href;
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
}
import App from "./App.jsx";
import { AuthProvider } from "./lib/auth.jsx";
import { ColorSchemeProvider } from "./lib/colorScheme.jsx";
import { TooltipProvider } from "./components/ui/tooltip.jsx";
import { Toaster } from "./components/ui/sonner.jsx";
import DisplayNameGate from "./components/DisplayNameGate.jsx";
import ServiceWorkerPrompt from "./lib/pwa.jsx";
import { SsrProvider } from "./lib/ssr.jsx";

// BrowserRouter gives every page a real path (e.g. /hub/:id), which is what
// lets the Worker recognise a route it can render server-side and what makes a
// deep link resolve (the assets binding serves index.html for unknown paths).
// AuthProvider exposes the Supabase session to every page. ColorSchemeProvider
// is outermost (and adopts a value already applied pre-paint by index.html's
// inline script) so light/dark is available everywhere.
//
// The tree below has to stay structurally in step with src/entry-server.jsx —
// anything that renders DOM must appear in both, in the same order, or
// hydration will find markup it didn't expect. ServiceWorkerPrompt is the one
// exception: it renders null, so its absence there changes nothing.
//
// Data the Worker rendered this page with, if it rendered it at all (see
// apps/api/src/routes/ssr.js and lib/ssr.jsx). Read and removed immediately:
// it's a one-shot handoff, and leaving a copy of the page's data on `window`
// serves nothing afterwards.
const bootstrap = window.__SSR__ ?? null;
delete window.__SSR__;

const tree = (
  <React.StrictMode>
    <ColorSchemeProvider>
      <TooltipProvider>
        <BrowserRouter>
          <SsrProvider bootstrap={bootstrap} origin={window.location.origin}>
            <AuthProvider>
              <DisplayNameGate>
                <App />
              </DisplayNameGate>
            </AuthProvider>
          </SsrProvider>
        </BrowserRouter>
        <Toaster />
        {/* Renders nothing; registers the PWA service worker and raises a toast
            when a new build is waiting. Outside the router because it isn't
            tied to any one page. */}
        <ServiceWorkerPrompt />
      </TooltipProvider>
    </ColorSchemeProvider>
  </React.StrictMode>
);

const container = document.getElementById("root");

// Hydrate what the Worker sent rather than throwing it away and re-rendering.
// A page it didn't render (the editor, a client-side navigation target, any
// route in the local dev server) arrives with an empty #root and mounts normally.
if (bootstrap) hydrateRoot(container, tree);
else createRoot(container).render(tree);
