// Registry of languages the UI can be switched to. Today this only lists
// English because only src/locales/en/ exists — see the docs at
// apps/docs/docs/web-app/internationalization.md for the steps to add a new
// language (locale JSON files + an entry here + registering it in
// src/lib/i18n.js's `resources`/`supportedLngs`).
export const LANGUAGES = [{ code: "en", label: "English" }];

export const DEFAULT_LANGUAGE = "en";
