import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

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

// What the first render assumes, before the stored choice has been read. The
// server has neither localStorage nor matchMedia, so it can only ever render
// this — and a hydrating client has to render the same thing or React tears the
// tree down and re-renders it. (NavActions' toggle shows a sun or a moon
// depending on `resolved`, so this is markup, not just a CSS variable.)
const INITIAL_SCHEME = "light";

// useLayoutEffect warns when it is reached through the server renderer, where
// it can't run at all. There is nothing to adopt on the server, so fall back to
// useEffect there and keep the before-paint timing in the browser.
const useAdoptEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function ColorSchemeProvider({ children }) {
  // Deliberately not seeded from storage: see INITIAL_SCHEME. The real value is
  // adopted below, in a *layout* effect, so it lands after hydration but before
  // the browser paints — there is no flash of the wrong toggle icon, and the
  // page's actual colours were already set pre-paint by index.html's inline
  // script regardless.
  const [scheme, setScheme] = useState("system");
  const [resolved, setResolved] = useState(INITIAL_SCHEME);

  useAdoptEffect(() => {
    setScheme(readStoredScheme());
  }, []);

  // Persisting belongs to the act of choosing, not to observing the state —
  // doing it in an effect would write the placeholder "system" over a stored
  // "dark" during the first render, before the value above has been adopted.
  const chooseScheme = useCallback((next) => {
    setScheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore write failures — the choice just won't persist this session.
    }
  }, []);

  useEffect(() => {
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
    () => ({ scheme, resolved, setScheme: chooseScheme }),
    [scheme, resolved, chooseScheme],
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
