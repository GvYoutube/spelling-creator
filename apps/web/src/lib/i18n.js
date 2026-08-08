// i18next setup. Only English ships today, but every user-facing string in
// the app is routed through this so a new language is just: add its locale
// directory under src/locales/<lng>/, list it in `resources` and
// `supportedLngs` below, and add an entry to LANGUAGES in
// src/lib/languages.js for the language switcher.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enAiDialogs from "../locales/en/aiDialogs.json";
import enCollab from "../locales/en/collab.json";
import enCommon from "../locales/en/common.json";
import enEditor from "../locales/en/editor.json";
import enEditorSections from "../locales/en/editorSections.json";
import enEditorTools from "../locales/en/editorTools.json";
import enHome from "../locales/en/home.json";
import enHub from "../locales/en/hub.json";
import enLesson from "../locales/en/lesson.json";
import enLogin from "../locales/en/login.json";
import enModeration from "../locales/en/moderation.json";
import enOauth from "../locales/en/oauth.json";
import enProfile from "../locales/en/profile.json";
import enRichText from "../locales/en/richText.json";

export const defaultNS = "common";

// Every namespace the app uses. Adding a new one? Register it here too, or
// useTranslation("yourNs") will silently render missing-key fallbacks.
export const namespaces = [
  "common",
  "home",
  "hub",
  "lesson",
  "login",
  "moderation",
  "oauth",
  "profile",
  "editor",
  "editorSections",
  "editorTools",
  "richText",
  "collab",
  "aiDialogs",
];

export const resources = {
  en: {
    common: enCommon,
    home: enHome,
    hub: enHub,
    lesson: enLesson,
    login: enLogin,
    moderation: enModeration,
    oauth: enOauth,
    profile: enProfile,
    editor: enEditor,
    editorSections: enEditorSections,
    editorTools: enEditorTools,
    richText: enRichText,
    collab: enCollab,
    aiDialogs: enAiDialogs,
  },
};

// Everything except which language to start in and how to work that out. The
// server render (src/entry-server.jsx) reuses this and supplies its own — it
// has no localStorage and no navigator, and it always renders "en".
export const baseConfig = {
  resources,
  ns: namespaces,
  defaultNS,
  fallbackLng: "en",
  supportedLngs: ["en"],
  interpolation: {
    // React already escapes values when rendering, so double-escaping here
    // would mangle apostrophes/ampersands in interpolated strings.
    escapeValue: false,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    ...baseConfig,
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

export default i18n;
