import path from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Paths the Cloudflare Worker answers itself, so the service worker must never
// resolve a navigation to them from the precached SPA shell. `run_worker_first`
// means the Worker sees every request before the static assets do (see
// apps/api/wrangler.jsonc), and these are the paths it doesn't hand back to
// env.ASSETS — /docs is the statically-built VitePress site copied into dist/docs
// after this build, the rest are Worker routes (apps/api/src/index.js). Anything
// not listed here is assumed to be a client-side route in src/App.jsx.
//
// A denylist rather than an allowlist: adding a page to App.jsx shouldn't
// require a matching edit here, and the failure mode is the gentler one — an
// unlisted SPA route falls through to the network, which online still lands on
// index.html via the Worker's single-page-application fallback.
const WORKER_PATHS = [
  // The server-rendered routes (apps/api/src/routes/ssr.js). These have to be
  // here or the service worker answers the navigation from its precached shell
  // and the Worker is never asked — which silently turns SSR off for every
  // returning visitor, the exact people whose browsers have the shell cached.
  // Nothing is lost offline: all three need the network for their data anyway.
  /^\/hub(\/|$)/,
  /^\/users\//,
  /^\/docs(\/|$)/,
  /^\/images\//,
  /^\/git\//,
  /^\/collab(\/|$)/,
  /^\/og-image(\/|\?|$)/,
  /^\/authorize(\/|\?|$)/,
  /^\/token(\/|$)/,
  /^\/register(\/|$)/,
  /^\/mcp(\/|$)/,
  /^\/\.well-known\//,
  /^\/(sitemap\.xml|robots\.txt|feed\.xml|spelling-words\.json)$/,
];

// Modules that exist only behind a click or a route the Worker never renders.
// They are all reached through a dynamic import(), so the server build pulls
// them in as emitted chunks it can never execute — the export pipeline alone is
// 3.6 MB of docx/mammoth/html2pdf, and the editor another 550 kB, all of it
// uploaded to the edge to sit unused. Replacing them with a stub in the SSR
// build keeps the Worker to what it can actually run.
//
// Safe only because nothing static-imports them: src/lib/exports/load.js and
// the lazy routes in src/App.jsx both use import(), so there are no named
// bindings for the stub to fail to provide.
const SSR_UNREACHABLE = [
  "src/lib/exports/engine.js",
  "src/pages/EditorPage.jsx",
  "src/pages/ModerationPage.jsx",
  "src/pages/LoginPage.jsx",
  "src/pages/OAuthAuthorizePage.jsx",
];

function stubUnreachableOnServer() {
  const targets = new Set(
    SSR_UNREACHABLE.map((p) => path.resolve(__dirname, p)),
  );
  const STUB_ID = "\0ssr-unreachable";
  return {
    name: "stub-unreachable-on-server",
    // Ahead of vite:resolve — a normal-phase plugin never gets asked, because
    // the built-in resolver has already returned an id by then.
    enforce: "pre",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      return resolved && targets.has(resolved.id) ? STUB_ID : null;
    },
    load(id) {
      if (id !== STUB_ID) return null;
      // Reaching this means the route table and this list disagree.
      return `export default function SsrUnreachable() {
  throw new Error("This module was stubbed out of the server build (vite.config.js).");
}\n`;
    },
  };
}

// `VITE_`-prefixed env vars from apps/web/.env are exposed to client code as
// `import.meta.env.VITE_*` natively — no config needed. src/main.jsx is the
// only place in the app that reads them (see packages/core/src/config.js).
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [
    isSsrBuild && stubUnreachableOnServer(),
    react(),
    // The React Compiler runs as a Babel pass. This used to pass
    // `target: "18"`, which makes it emit imports from the `react-compiler-runtime`
    // shim; on React 19 the memoisation hooks it needs are exported by React
    // itself as `react/compiler-runtime`, so the target matches the installed
    // React and the shim package is gone.
    babel({ presets: [reactCompilerPreset({ target: "19" })] }),
    tailwindcss(),
    // Progressive web app: the installable manifest plus a Workbox service
    // worker that precaches the built shell. The editor already keeps lessons
    // in IndexedDB (LightningFS + the image store), so precaching the shell is
    // what makes it genuinely usable with no network — see the docs at
    // apps/docs/docs/web-app/pwa-and-offline.md.
    VitePWA({
      // "prompt", not "autoUpdate": this app is an editor, and swapping the
      // running build out from under someone mid-lesson is not something to do
      // silently. src/lib/pwa.jsx turns this into a toast with a Reload action.
      registerType: "prompt",
      // No auto-injected registration snippet: src/lib/pwa.jsx registers the
      // worker itself so it can own the update UI. The <link rel="manifest">
      // is still injected into index.html either way; the icon and theme-color
      // tags the plugin doesn't own are written by hand there.
      injectRegister: null,
      manifest: {
        // Explicit id so the install identity survives any future change to
        // start_url (browsers otherwise derive it from start_url).
        id: "/",
        name: "Spelling Lesson Maker",
        short_name: "Spelling",
        description:
          "Create and print Spelling lessons with sections, text, and images.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        lang: "en",
        dir: "ltr",
        categories: ["education", "productivity"],
        // Matches AppHeader's --primary bar and the page --background in
        // src/styles/globals.css, so the OS chrome and the splash screen are
        // continuous with the app's own light theme.
        theme_color: "#4f5fd9",
        background_color: "#dee3f3",
        icons: [
          // "any" icons are drawn as-is (they carry their own rounded corners);
          // the maskable one is a full-bleed square the platform crops to its
          // own shape. Both are generated from the SVGs beside them — see the
          // docs page for the command.
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
          {
            src: "/icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        shortcuts: [
          { name: "New lesson", short_name: "Editor", url: "/editor" },
          { name: "Lesson hub", short_name: "Hub", url: "/hub" },
        ],
      },
      workbox: {
        // The built shell: entry HTML, JS/CSS chunks, the self-hosted Fontsource
        // woff2 files and the icons. Deliberately not the homepage's feature
        // screenshots (public/home/*.jpg, ~245 KB) — marketing images aren't
        // worth an install-time download; the runtime rule below picks them up
        // the first time someone actually sees the homepage.
        globPatterns: ["**/*.{html,js,css,woff2,svg,png,ico}"],
        // dist/docs is the VitePress site, copied in by `pnpm build:docs` after
        // this build. It has its own hashed assets and its own pages; nothing
        // there belongs in the app's precache. (`pnpm build` empties dist first,
        // so this normally matches nothing — it's a guard against a rebuild that
        // runs the other way round.)
        globIgnores: ["docs/**"],
        // The vendor chunk is over Workbox's 2 MiB default on its own.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // Client-side routes are served the precached shell; App.jsx then
        // renders the right page. See WORKER_PATHS above for the exceptions.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: WORKER_PATHS,
        runtimeCaching: [
          {
            // Lesson images are addressed by the SHA-256 of their bytes
            // (packages/core/src/browser/imageRef.js), so a given URL can never
            // change content — cache-first, and never revalidate. Matched by a
            // callback rather than a RegExp because VITE_API_URL may point at a
            // different origin, and Workbox only applies a RegExp route
            // cross-origin when it matches from the very start of the URL.
            urlPattern: ({ url }) =>
              /^\/images\/[0-9a-f]{64}$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "lesson-images",
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              // 200 only — deliberately *not* 0. An opaque response carries no
              // status, so a cross-origin 404 or 502 is indistinguishable from
              // a hit, and CacheFirst would then serve that error from the
              // cache for the full 30 days without ever retrying: one blip
              // while an image is still uploading breaks it permanently.
              // (Opaque entries are also quota-padded to megabytes apiece,
              // which 300 of would blow the origin's storage budget.)
              //
              // Nothing is lost in the deployed app: the Worker serves the SPA
              // and /images from the same origin (apps/api/wrangler.jsonc), so
              // these responses are `basic` with a real status. A self-host
              // that points VITE_API_URL at another origin just doesn't get
              // offline images — the browser's own HTTP cache still applies —
              // which is the right way round from poisoning the cache.
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Everything else same-origin and image-shaped: today that's the
            // homepage's feature screenshots in public/home.
            urlPattern: ({ request, sameOrigin }) =>
              sameOrigin && request.destination === "image",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "static-images",
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      // The service worker is a production concern; leaving it off in dev keeps
      // the usual Vite HMR behaviour (and no stale-cache confusion). Flip
      // `enabled` to true temporarily to debug the SW itself.
      devOptions: { enabled: false },
    }),
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
  // The server build (`pnpm build:ssr` -> dist-ssr/entry-server.js) that the
  // Worker imports. `target: "webworker"` and the `react-dom/server.browser`
  // entry below are what keep it inside the Web-standard surface workerd
  // provides: no node:stream, no Node globals.
  //
  // Nothing is externalised — the Worker has no node_modules to resolve at
  // runtime, so React and every component have to be in the bundle.
  ssr: {
    target: "webworker",
    noExternal: true,
    resolve: {
      conditions: ["workerd", "worker", "browser", "module", "import"],
    },
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
}));
