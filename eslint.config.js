import js from "@eslint/js";
import globals from "globals";
import pluginReact from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "**/dist/**",
    "**/build/**",
    "**/node_modules/**",
    "**/.wrangler/**",
    "**/doc_build/**",
  ]),

  // Base JS rules for every file
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          caughtErrors: "none",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Web app — React in the browser (modern JSX transform, no PropTypes)
  {
    files: ["apps/web/**/*.{js,jsx}"],
    extends: [
      pluginReact.configs.flat.recommended,
      pluginReact.configs.flat["jsx-runtime"],
    ],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    settings: { react: { version: "18.3" } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react/prop-types": "off",
      // Resetting local state when a dialog opens / a route param changes is an
      // intentional, well-contained pattern here, not the cascading-render
      // smell this (new, strict) rule targets.
      "react-hooks/set-state-in-effect": "off",
    },
  },

  // API — Cloudflare Worker runtime
  {
    files: ["apps/api/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.node,
        // Cloudflare-specific runtime global (Durable Object WebSockets).
        WebSocketPair: "readonly",
      },
    },
  },

  // MCP server — Node runtime (also uses Web-standard fetch/crypto globals)
  {
    files: ["apps/mcp/**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
]);
