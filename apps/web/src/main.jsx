import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { configureCore } from "@spelling-creator/core/config";

// Hand the shared package the one piece of build-time configuration it needs,
// before anything imports a module that reads it. `import.meta.env` is
// substituted by Rsbuild and exists nowhere else, so core takes it through this
// seam rather than reaching for the bundler itself — see packages/core/src/config.js.
configureCore({ apiUrl: import.meta.env.VITE_API_URL });
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
// Rsbuild fingerprints these URLs at build time, so we resolve them via ?url
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

// BrowserRouter gives every page a real path (e.g. /hub/:id) so the Worker can
// see which page a crawler requested and return a prerendered snapshot. The
// Worker serves index.html for unknown paths (assets single-page-application
// fallback), so client-side deep links resolve. AuthProvider exposes the
// Supabase session to every page. ColorSchemeProvider is outermost (and reads
// a value already applied pre-paint by index.html's inline script) so
// light/dark is available everywhere.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ColorSchemeProvider>
      <TooltipProvider>
        <BrowserRouter>
          <AuthProvider>
            <DisplayNameGate>
              <App />
            </DisplayNameGate>
          </AuthProvider>
        </BrowserRouter>
        <Toaster />
      </TooltipProvider>
    </ColorSchemeProvider>
  </React.StrictMode>,
);
