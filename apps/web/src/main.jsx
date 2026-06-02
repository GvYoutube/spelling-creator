import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
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
