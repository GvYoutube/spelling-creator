import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

// html2pdf.js / mammoth pull in some Node-ish globals; this keeps the
// browser build happy by mapping `global` to `window`.
export default defineConfig({
  plugins: [
    react(),
    legacy({
      targets: ["defaults", "not IE 11"],
    }),
  ],
  define: {
    global: "globalThis",
  },
});
