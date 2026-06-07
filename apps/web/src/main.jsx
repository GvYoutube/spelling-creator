import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
// Self-hosted Roboto via Fontsource (loads faster than the Google Fonts CDN).
// Weights match the theme's typography (300/400/500/700).
import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
// Preload the weights so the fonts are fetched in parallel with the bundle and
// are ready before first paint — avoids the flash of fallback (unstyled) text.
// Vite fingerprints these URLs at build time, so we resolve them via ?url
// rather than hardcoding hashed paths in index.html.
import roboto300 from "@fontsource/roboto/files/roboto-latin-300-normal.woff2?url";
import roboto400 from "@fontsource/roboto/files/roboto-latin-400-normal.woff2?url";
import roboto500 from "@fontsource/roboto/files/roboto-latin-500-normal.woff2?url";
import roboto700 from "@fontsource/roboto/files/roboto-latin-700-normal.woff2?url";

for (const href of [roboto300, roboto400, roboto500, roboto700]) {
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "font";
  link.type = "font/woff2";
  link.href = href;
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
}
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import App from "./App.jsx";
import theme from "./theme.js";
import { AuthProvider } from "./lib/auth.jsx";
import DisplayNameGate from "./components/DisplayNameGate.jsx";

// BrowserRouter gives every page a real path (e.g. /hub/:id) so the Worker can
// see which page a crawler requested and return a prerendered snapshot. The
// Worker serves index.html for unknown paths (assets single-page-application
// fallback), so client-side deep links resolve. AuthProvider exposes the
// Supabase session to every page.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthProvider>
          <DisplayNameGate>
            <App />
          </DisplayNameGate>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
