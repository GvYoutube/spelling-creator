---
title: Project structure
sidebar_position: 12
---

# Project structure

```
src/
  App.jsx                 route table (editor / hub / login)
  main.jsx                React entry point: HashRouter + AuthProvider + theme
  theme.js                MUI theme
  pages/
    EditorPage.jsx        the lesson builder (toolbar, section list, + button, publish)
    HubPage.jsx           public gallery of published lessons + preview dialog
    LoginPage.jsx         magic-link sign-in / account status
  components/
    NavActions.jsx        shared header nav: hub link + account (sign in / out) menu
    CommentsSection.jsx   lesson comments list + post box (shown in the hub preview)
    SectionCard.jsx       a named section with its content blocks + add buttons
    ContentBlock.jsx      a single text, image, or question block
    AiTextDialog.jsx      Turnstile-verified "suggest text with AI" dialog
    AiQuestionDialog.jsx  Turnstile-verified "suggest a question with AI" dialog
    ImageSearchDialog.jsx Turnstile-verified "search Pixabay images" dialog
  lib/
    docxExport.js         build + download the .docx (text, images, questions)
    pdfExport.js          docx -> html (mammoth) -> pdf (html2pdf.js)
    htmlPreview.js        docx -> html (mammoth) for in-app preview / hub viewer
    questions.js          question type definitions, colours, block factories
    aiSuggest.js          calls the spelling-creator-cf Worker for text + questions
    pixabay.js            calls the spelling-creator-cf Worker to search + fetch images
    lessons.js            calls the Worker to list / fetch / publish hub lessons
    comments.js           calls the Worker to list / post lesson comments
    supabase.js           Supabase client (auth only) + supabaseEnabled flag
    auth.jsx              AuthProvider + useAuth (session, magic link, sign out)
    googleDrive.js        OAuth2 + upload the docx to Drive as a Google Doc
    turnstile.js          Cloudflare Turnstile loader + site key
    image.js              file reading, sizing, data-url helpers
    storage.js            localStorage auto-save
    id.js                 id generation
```
