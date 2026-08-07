import { defineConfig } from "@rspress/core";

// This runs in Node.js during the build — no browser APIs here.
export default defineConfig({
  // Docs live in ./docs and are authored as Markdown/MDX.
  root: "docs",

  // Served as a sub-path of the main site. The Cloudflare Worker (apps/api)
  // hosts the web SPA and this docs site from one assets bundle: the `build`
  // script renders here, then copies the static output into apps/web/dist/docs
  // so `wrangler deploy` ships the docs alongside the SPA, reached at /docs/.
  // Rspress emits a purely static bundle (no server runtime), so we render to
  // the default ./doc_build dir and copy it into apps/web/dist/docs.
  base: "/docs/",
  outDir: "doc_build",

  title: "Spelling Creator",
  description: "Documentation and updates for Spelling Creator",
  icon: "/img/favicon.ico",
  logo: "/img/logo.svg",
  logoText: "Spelling Creator",

  llms: true,

  themeConfig: {
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/playforge-coding/spelling-creator",
      },
    ],
    editLink: {
      docRepoBaseUrl:
        "https://github.com/playforge-coding/spelling-creator/tree/master/apps/docs/docs",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: `Copyright © ${new Date().getFullYear()} Spelling Creator.`,
    },
    // A single sidebar for the whole site (mounted at base "/docs/"). Links are
    // relative to the base — Rspress prepends it automatically.
    sidebar: {
      "/": [
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
          ],
        },
        {
          text: "Web App",
          collapsed: false,
          items: [
            { text: "Overview & features", link: "/web-app/overview" },
            { text: "Pages & routing", link: "/web-app/pages-and-routing" },
            { text: "Question blocks", link: "/web-app/question-blocks" },
            {
              text: "AI text suggestions",
              link: "/web-app/ai-text-suggestions",
            },
            {
              text: "AI question suggestions",
              link: "/web-app/ai-question-suggestions",
            },
            { text: "AI lesson ideas", link: "/web-app/ai-lesson-ideas" },
            {
              text: "Lesson summaries (on-device AI)",
              link: "/web-app/lesson-summaries",
            },
            { text: "Search images", link: "/web-app/search-images" },
            {
              text: "Save to Google Docs",
              link: "/web-app/save-to-google-docs",
            },
            { text: "Live collaboration", link: "/web-app/live-collaboration" },
            {
              text: "Lesson hub & accounts",
              link: "/web-app/lesson-hub-and-accounts",
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
          ],
        },
        {
          text: "MCP Server",
          collapsed: false,
          items: [
            { text: "Overview", link: "/mcp-server/overview" },
            { text: "Tools", link: "/mcp-server/tools" },
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
  },
});
