import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Expose the VITE_-prefixed env vars to client code as `import.meta.env.VITE_*`,
// preserving the previous Vite behaviour. loadEnv reads apps/web/.env (and
// .env.local / .env.[mode]) from the project root.
const { publicVars } = loadEnv({ prefixes: ["VITE_"] });

export default defineConfig({
  plugins: [
    pluginReact({
      // `target: "18"` makes the React Compiler emit imports from
      // `react-compiler-runtime` instead of React 19's `react/compiler-runtime`,
      // which React 18 does not export.
      reactCompiler: {
        target: "18",
      },
    }),
    pluginTailwindcss(),
  ],
  source: {
    entry: {
      index: "./src/main.jsx",
    },
    define: {
      ...publicVars,
      // html2pdf.js / mammoth reference a Node-ish `global`; map it to
      // globalThis so the browser build resolves it (was Vite's `define`).
      global: "globalThis",
    },
  },
  resolve: {
    // "@/..." mirrors shadcn/ui's default alias convention. New shadcn-sourced
    // code uses it; pre-existing app code keeps its relative imports.
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  html: {
    // Reuse the hand-written index.html (social meta tags + external scripts).
    // Rsbuild injects the entry <script> and favicon <link> automatically.
    template: "./index.html",
    favicon: "./src/favicon.svg",
  },
  output: {
    // Mirror the old @vitejs/plugin-legacy targets. Rsbuild down-compiles JS and
    // CSS syntax to this browserslist, so a separate legacy plugin is no longer
    // needed. (No core-js polyfills are injected — `output.polyfill` defaults to
    // "off"; enabling it would mean adding core-js v3 as a dependency.)
    overrideBrowserslist: ["defaults", "not IE 11"],
  },
});
