import { createContext, useContext, useEffect, useMemo, useState } from "react";

// Persisted user choice: "light" | "dark" | "system". Resolved value (what's
// actually applied) is always "light" | "dark" — "system" tracks the OS via
// matchMedia. Mirrors the mechanism proven out in the approved design mockup:
// data-theme="light"|"dark" on <html>, read by every CSS variable block in
// src/styles/globals.css. A blocking inline script in index.html applies the
// stored/OS value before first paint to avoid a flash of the wrong theme.
const STORAGE_KEY = "spelling-creator:color-scheme";

const ColorSchemeContext = createContext(null);

function getSystemScheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readStoredScheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage unavailable (private browsing, etc.) — fall back to system.
  }
  return "system";
}

export function ColorSchemeProvider({ children }) {
  const [scheme, setScheme] = useState(readStoredScheme);
  const [resolved, setResolved] = useState(() =>
    scheme === "system" ? getSystemScheme() : scheme,
  );

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, scheme);
    } catch {
      // Ignore write failures — the choice just won't persist this session.
    }

    if (scheme !== "system") {
      setResolved(scheme);
      return;
    }

    setResolved(getSystemScheme());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(getSystemScheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [scheme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);

  const value = useMemo(
    () => ({ scheme, resolved, setScheme }),
    [scheme, resolved],
  );

  return (
    <ColorSchemeContext.Provider value={value}>
      {children}
    </ColorSchemeContext.Provider>
  );
}

export function useColorScheme() {
  const ctx = useContext(ColorSchemeContext);
  if (!ctx) {
    throw new Error("useColorScheme must be used within ColorSchemeProvider");
  }
  return ctx;
}
