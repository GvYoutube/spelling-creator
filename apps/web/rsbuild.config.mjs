import { defineConfig, loadEnv } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

// Expose the VITE_-prefixed env vars to client code as `import.meta.env.VITE_*`,
// preserving the previous Vite behaviour. loadEnv reads apps/web/.env (and
// .env.local / .env.[mode]) from the project root.
const { publicVars } = loadEnv({ prefixes: ["VITE_"] });

export default defineConfig({
  plugins: [
    pluginReact({
      reactCompiler: true,
    }),
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
  html: {
    // Reuse the hand-written index.html (social meta tags + external scripts).
    // Rsbuild injects the entry <script> and favicon <link> automatically.
    template: "./index.html",
    favicon: "./src/favicon.svg",
  },
  output: {
    // Mirror the old @vitejs/plugin-legacy targets. Rsbuild down-compiles and
    // injects core-js polyfills based on this browserslist, so a separate
    // legacy plugin is no longer needed.
    overrideBrowserslist: ["defaults", "not IE 11"],
  },
});
