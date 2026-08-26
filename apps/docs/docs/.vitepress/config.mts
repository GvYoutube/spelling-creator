import { execFileSync } from "node:child_process";
import llmstxt from "vitepress-plugin-llms";
import { defineConfig } from "vitepress";

// The public origin the docs are published under. Used for the sitemap's
// absolute URLs and for the absolute links in llms.txt.
const SITE_ORIGIN = "https://spellingcreator.org";

/**
 * Whether this build can ask git when each page last changed.
 *
 * `lastUpdated` runs `git log` per page, which is fine in a checkout and in CI
 * and fails the entire build anywhere else — inside a container without git
 * installed, or in a build from a source tarball that has no `.git` at all. Both
 * are ordinary ways to build this (see the Dockerfile), and a missing timestamp
 * is not worth failing over.
 *
 * Detected rather than configured, so it needs no flag to be passed and cannot
 * be got wrong. Checks for a repository too, not just the binary: git being
 * installed says nothing about whether there is any history to read.
 */
function gitHistoryAvailable(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT_HISTORY = gitHistoryAvailable();

// This runs in Node.js during the build — no browser APIs here.
export default defineConfig({
  // Served as a sub-path of the main site. The Cloudflare Worker (apps/api)
  // hosts the web SPA and this docs site from one assets bundle: the `build`
  // script renders here, then copies the static output into apps/web/dist/docs
  // so `wrangler deploy` ships the docs alongside the SPA, reached at /docs/.
  // VitePress emits a purely static bundle (no server runtime). outDir is
  // resolved from this config's project root (apps/docs/docs), so ../doc_build
  // renders to apps/docs/doc_build — the directory the `build` script copies
  // into apps/web/dist/docs from.
  base: "/docs/",
  outDir: "../doc_build",

  // Extensionless URLs (/docs/intro, not /docs/intro.html) — the links the
  // READMEs already point at. Cloudflare's static-asset handling defaults to
  // `auto-trailing-slash`, so it resolves /docs/intro to intro.html for us.
  cleanUrls: true,

  title: "Spelling Creator",
  description: "Documentation and updates for Spelling Creator",
  head: [["link", { rel: "icon", href: "/docs/img/favicon.ico" }]],

  // Every page ships a <lastmod> in the sitemap, taken from git — where there is
  // git to take it from. A build without it (a container, a source tarball)
  // simply omits the timestamps rather than failing; see gitHistoryAvailable.
  lastUpdated: HAS_GIT_HISTORY,

  // Built-in sitemap generation. The hostname includes `base`, as VitePress
  // requires, so the emitted URLs are the real published ones under /docs/.
  // Written to doc_build/sitemap.xml → served at /docs/sitemap.xml, which
  // robots.txt (apps/api/src/routes/seo.js) points crawlers at alongside the
  // Worker's own dynamic /sitemap.xml for the app pages.
  sitemap: {
    hostname: `${SITE_ORIGIN}/docs/`,
  },

  vite: {
    // Emits llms.txt, llms-full.txt and a Markdown twin of every page, so an
    // assistant can read the docs without scraping the rendered HTML.
    plugins: [llmstxt({ domain: SITE_ORIGIN })],
  },

  themeConfig: {
    logo: "/img/logo.svg",
    siteTitle: "Spelling Creator",
    search: { provider: "local" },
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/playforge-coding/spelling-creator",
      },
    ],
    editLink: {
      pattern:
        "https://github.com/playforge-coding/spelling-creator/edit/main/apps/docs/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: `Copyright © ${new Date().getFullYear()} Spelling Creator.`,
    },
    // A single sidebar for the whole site (mounted at base "/docs/"). Links are
    // relative to the base — VitePress prepends it automatically.
    sidebar: [
      { text: "Intro", link: "/intro" },
      {
        text: "Monorepo",
        collapsed: false,
        items: [
          { text: "Overview", link: "/monorepo/overview" },
          { text: "Getting started", link: "/monorepo/getting-started" },
          {
            text: "Lesson images (binary, R2 + IndexedDB)",
            link: "/monorepo/lesson-images",
          },
          {
            text: "Version history (git, by content block)",
            link: "/monorepo/version-history",
          },
          { text: "The platform seam", link: "/monorepo/platform-seam" },
          { text: "Self-hosting", link: "/monorepo/self-hosting" },
          { text: "Frontend migration", link: "/monorepo/frontend-migration" },
        ],
      },
      {
        text: "Web App",
        collapsed: false,
        items: [
          { text: "Overview & features", link: "/web-app/overview" },
          { text: "Pages & routing", link: "/web-app/pages-and-routing" },
          {
            text: "Lessons on this device",
            link: "/web-app/local-lessons",
          },
          { text: "Server rendering", link: "/web-app/server-rendering" },
          { text: "Question blocks", link: "/web-app/question-blocks" },
          { text: "AI text suggestions", link: "/web-app/ai-text-suggestions" },
          {
            text: "AI question suggestions",
            link: "/web-app/ai-question-suggestions",
          },
          { text: "AI lesson ideas", link: "/web-app/ai-lesson-ideas" },
          {
            text: "Lesson summaries (on-device AI)",
            link: "/web-app/lesson-summaries",
          },
          {
            text: "Interactive lesson mode",
            link: "/web-app/interactive-mode",
          },
          { text: "Search images", link: "/web-app/search-images" },
          { text: "Save to Google Docs", link: "/web-app/save-to-google-docs" },
          { text: "Live collaboration", link: "/web-app/live-collaboration" },
          {
            text: "Variations (trying something out)",
            link: "/web-app/lesson-variations",
          },
          {
            text: "Pull requests (proposing changes)",
            link: "/web-app/pull-requests",
          },
          {
            text: "Lesson hub & accounts",
            link: "/web-app/lesson-hub-and-accounts",
          },
          {
            text: "Rich text (comments & bios)",
            link: "/web-app/rich-text",
          },
          {
            text: "Profiles & display names",
            link: "/web-app/profiles-and-display-names",
          },
          { text: "Notifications", link: "/web-app/notifications" },
          { text: "Moderation", link: "/web-app/moderation" },
          { text: "Getting started", link: "/web-app/getting-started" },
          {
            text: "How the export pipeline works",
            link: "/web-app/export-pipeline",
          },
          { text: "Project structure", link: "/web-app/project-structure" },
          {
            text: "Mobile layout & touch targets",
            link: "/web-app/mobile-layout",
          },
          {
            text: "Navigating large lessons",
            link: "/web-app/navigating-large-lessons",
          },
          {
            text: "Installable app & offline use",
            link: "/web-app/pwa-and-offline",
          },
          {
            text: "Internationalization",
            link: "/web-app/internationalization",
          },
        ],
      },
      {
        text: "MCP Server",
        collapsed: false,
        items: [
          { text: "Overview", link: "/mcp-server/overview" },
          { text: "Tools", link: "/mcp-server/tools" },
          {
            text: "Interactive views (MCP Apps)",
            link: "/mcp-server/interactive-views",
          },
          {
            text: "Lesson validation (errors & warnings)",
            link: "/mcp-server/lesson-validation",
          },
          {
            text: "Install as a one-click bundle (.mcpb)",
            link: "/mcp-server/install-bundle",
          },
          {
            text: "Setup (manual / for development)",
            link: "/mcp-server/setup",
          },
          { text: "Configuration", link: "/mcp-server/configuration" },
          { text: "Development", link: "/mcp-server/development" },
          { text: "Packaging the bundle", link: "/mcp-server/packaging" },
          { text: "Remote (hosted) mode", link: "/mcp-server/remote-mode" },
        ],
      },
    ],
  },
});
