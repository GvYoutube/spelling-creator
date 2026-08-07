import path from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `VITE_`-prefixed env vars from apps/web/.env are exposed to client code as
// `import.meta.env.VITE_*` natively — no config needed. src/main.jsx is the
// only place in the app that reads them (see packages/core/src/config.js).
export default defineConfig({
  plugins: [
    react(),
    // The React Compiler runs as a Babel pass. `target: "18"` makes it emit
    // imports from `react-compiler-runtime` instead of React 19's
    // `react/compiler-runtime`, which React 18 does not export.
    babel({ presets: [reactCompilerPreset({ target: "18" })] }),
    tailwindcss(),
  ],
  resolve: {
    // "@/..." mirrors shadcn/ui's default alias convention. New shadcn-sourced
    // code uses it; pre-existing app code keeps its relative imports. Kept in
    // sync with jsconfig.json so editors resolve it too.
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  define: {
    // html2pdf.js / mammoth reference a Node-ish `global`; map it to globalThis
    // so the browser build resolves it.
    global: "globalThis",
  },
  build: {
    rolldownOptions: {
      output: {
        // Rolldown puts everything reachable from the entry into one chunk;
        // Rsbuild used to split vendors out by default. Without this, editing
        // any app file invalidates the whole ~3.4 MB bundle for returning
        // visitors instead of just the app chunk. Dependencies that change on
        // their own cadence get their own long-lived chunks.
        //
        // `tags: ["$initial"]` confines both groups to the statically-reachable
        // graph. Without it the vendor group also swallows dependencies that are
        // only reached through a dynamic import — isomorphic-git and LightningFS
        // (~185 KB the editor loads on demand via src/lib/git/load.js) and the
        // tsparticles shapes — putting them back in the bundle every homepage
        // visitor downloads.
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/,
              tags: ["$initial"],
              priority: 20,
            },
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/]/,
              tags: ["$initial"],
              priority: 10,
            },
          ],
        },
      },
    },
  },
  // No `build.target` override. Vite 8 defaults to `baseline-widely-available`
  // (chrome111, edge111, firefox114, safari16.4, ios16.4), which is *wider*
  // than the `["defaults", "not IE 11"]` browserslist this app used to compile
  // against — that query now resolves to a floor of chrome 109, edge 146,
  // firefox 140, safari 26.3. Chrome 109-110 is the only coverage given up.
});
