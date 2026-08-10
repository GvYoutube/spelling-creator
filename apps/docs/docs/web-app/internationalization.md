---
title: Internationalization
---

# Internationalization

Every user-facing string in the web app is routed through
[react-i18next](https://react.i18next.com), so a new language is a matter of adding
translation files, not touching component code. Only English ships today, but the
app is fully wired for more.

## The pieces

| File                                                                                              | Role                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/lib/i18n.js`                                                                                 | i18next setup: registers every namespace's English resources, `fallbackLng`, `supportedLngs`. |
| `src/lib/languages.js`                                                                            | `LANGUAGES` registry for a future language switcher; today lists only English.                |
| `src/locales/<lng>/*.json`                                                                        | One JSON file per namespace, per language. Only `en/` exists today.                           |
| [`i18next-browser-languagedetector`](https://github.com/i18next/i18next-browser-languageDetector) | Picks the visitor's language from `localStorage` then the browser, falling back to English.   |

`main.jsx` imports `./lib/i18n.js` once, before `App` renders, so every component can
call `useTranslation()` immediately.

## Namespaces

Strings are split into namespaces roughly by page or feature area, not lumped into
one file — keeps each JSON file a manageable size and lets a translator work on one
area without wading through the whole app:

| Namespace        | Covers                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common`         | `PageBar`, `AppSidebar`, notification bell, display-name gate/dialog, the install prompt and service-worker update toast, shared `ui/` primitives |
| `home`           | `HomePage` (marketing splash + signed-in dashboard)                                                                                               |
| `hub`            | `HubPage`                                                                                                                                         |
| `lesson`         | `LessonPage`, `LessonView`, `LessonSummary`, `CommentsSection`                                                                                    |
| `interactive`    | `InteractiveLesson` (the full-screen walkthrough and its speech controls), `MyLessonAnswers`                                                      |
| `login`          | `LoginPage`                                                                                                                                       |
| `moderation`     | `ModerationPage`                                                                                                                                  |
| `oauth`          | `OAuthAuthorizePage`                                                                                                                              |
| `profile`        | `ProfilePage`, `BioDialog`, `FollowListDialog`                                                                                                    |
| `editor`         | `EditorPage`                                                                                                                                      |
| `editorSections` | `SectionCard`, `ContentBlock`, `LiveField`                                                                                                        |
| `editorTools`    | `HistoryDialog` (incl. its `timeAgo` helper), `MergeDialog`, `ImageSearchDialog`                                                                  |
| `richText`       | `RichText`, `RichTextInput`, `RichTextToolbar`                                                                                                    |
| `collab`         | `CollaborateDialog`, `CollabChat`, `CollabCursors`                                                                                                |
| `aiDialogs`      | `FirstLessonWizard`, `AiLessonIdeaDialog`, `AiQuestionDialog`, `AiTextDialog`                                                                     |

## Usage in a component

```jsx
import { useTranslation } from "react-i18next";

function Example() {
  const { t } = useTranslation("hub");
  return <button>{t("filters.clear")}</button>;
}
```

Keys are nested and namespaced by component/section (`{"filters": {"clear": "Clear filters"}}`),
not flat, so a namespace's JSON mirrors the shape of the UI it backs.

Counted values use i18next's plural key suffixes rather than hand-rolled `... === 1 ?`
logic:

```jsx
t("resultCount", { count }); // resultCount_one / resultCount_other in the JSON
```

A plain (non-component) helper — `HistoryDialog.jsx`'s exported `timeAgo()` — can't call
`useTranslation`, so it imports the shared `i18n` instance directly and calls
`i18n.t("editorTools:timeAgo.minutes", { count })`, with the namespace prefixed
explicitly since there's no `useTranslation` scoping it.

## What isn't translated

Not every string in a migrated file goes through `t()`. Left as-is, deliberately:

- Debug-only `console.*` output and code comments.
- CSS class names, `data-*`/technical `aria-*` values, internal state-machine string
  literals (e.g. `"idle"`, `"docx"`, `"ours"`).
- User-authored content — lesson text, comments, bios, display names — which is data,
  not app copy.
- Third-party attribution text supplied by an API (e.g. a Wikimedia image's own
  caption).

## Adding a language

1. Copy `src/locales/en/` to `src/locales/<lng>/` and translate every value (keep the
   keys and any `{{placeholders}}`/`_one`/`_other` suffixes identical).
2. In `src/lib/i18n.js`, import the new namespace files and add the language under
   `resources`, and add its code to `supportedLngs`.
3. Add `{ code: "<lng>", label: "..." }` to `LANGUAGES` in `src/lib/languages.js`.

No component changes are needed — every string already resolves through `t()`.
