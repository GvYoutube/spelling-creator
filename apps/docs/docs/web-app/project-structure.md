---
title: Project structure
sidebar_position: 15
---

# Project structure

```
src/
  App.jsx                 route table (editor / hub / lesson / profile / login / moderation)
  main.jsx                React entry: BrowserRouter + AuthProvider + DisplayNameGate + theme
  theme.js                MUI theme
  pages/
    EditorPage.jsx        the lesson builder (toolbar, section list, + button, publish, collaborate)
    HubPage.jsx           public gallery of published lessons + client-side search
    LessonPage.jsx        a single published lesson: renders via LessonView, plus comments + author link
    ProfilePage.jsx       a user's public profile: bio + their published lessons
    LoginPage.jsx         magic-link sign-in / account status
    ModerationPage.jsx    moderator/admin queue for reported content
  components/
    NavActions.jsx        shared header nav: hub link + account menu + notification bell
    NotificationBell.jsx  AppBar bell that polls for and shows the user's notifications
    DisplayNameGate.jsx   makes a signed-in user pick a display name before using the app
    DisplayNameDialog.jsx pick / change your public display name
    BioDialog.jsx         edit your public profile bio
    FirstLessonWizard.jsx dismissable step-by-step welcome guide for newcomers
    CommentsSection.jsx   lesson comments list + post box, incl. the 1–5 star rating input
    LessonView.jsx        read-only renderer for the lesson page (blocks straight to React, lazy images)
    LessonSummary.jsx     on-device AI summary card on the lesson page (hidden unless the browser supports it)
    SectionCard.jsx       a named section with its content blocks + add buttons; measures the pointer against its own rows during a block drag, but the drag itself is owned by EditorPage (blocks can move between sections)
    ContentBlock.jsx      a single text, spelling, image, or question block
    AiTextDialog.jsx       Turnstile-verified "suggest text with AI" dialog
    AiQuestionDialog.jsx   Turnstile-verified "suggest a question with AI" dialog
    AiLessonIdeaDialog.jsx Turnstile-verified "suggest a whole lesson outline with AI" dialog
    ImageSearchDialog.jsx  Turnstile-verified "search Pixabay images" dialog
    CollaborateDialog.jsx  live-collaboration control panel (host/join, roster, trusted collaborators)
    CollabCursors.jsx      floating coloured carets showing collaborators' selections
    CollabChat.jsx         floating in-session chat panel
    HistoryDialog.jsx      the lesson's version timeline: what each commit changed, per block, + restore
    MergeDialog.jsx        settle a merge with the lesson this one was forked from (mine / theirs / keep both)
  lib/
    docxExport.js         build + download the .docx (text, images, questions)
    docxImport.js         best-effort import of a .docx back into the lesson model
    pdfExport.js          docx -> html (mammoth) -> pdf (html2pdf.js)
    htmlPreview.js        docx -> html (mammoth) for the editor's in-app preview dialog + the PDF path (the hub lesson page renders directly via LessonView.jsx)
    questions.js          question type definitions, colours, block factories
    spelling.js           helpers for the explicit "spelling words" block
    ageRanges.js          the age ranges a lesson can be pitched at
    aiSuggest.js          calls the Worker for AI text / questions / lesson ideas
    summarizer.js         browser Summarizer API wrapper (on-device lesson summaries; fails closed)
    pixabay.js            calls the Worker to search + fetch Pixabay images
    lessons.js            calls the Worker to list / fetch / publish hub lessons
    lessonSearch.js       fully client-side hub search (Fuse.js)
    comments.js           calls the Worker to list / post lesson comments
    profile.js            calls the Worker for your own profile
    users.js              calls the Worker for other users' public profiles
    notifications.js      calls the Worker for the notification feed
    moderation.js         calls the Worker for the moderation queue
    collab.js             useCollaboration hook (one WebSocket to the CollabRoom Durable Object; doc sync, cursors, chat)
    presence.js           per-collaborator colour + selection presence helpers
    useSelectionBroadcast.js broadcasts the local editor selection to peers
    useDragAutoScroll.js  scrolls the page while a block drag hovers near a window edge (the browser only auto-scrolls a native drag while the pointer keeps moving)
    imageStore.js         IndexedDB storage for the working lesson + its images
    imageRef.js           binary image-ref model (a block references its bytes)
    imagesClient.js       uploads a lesson's images to the Worker (R2) on publish
    git/                  version history — every lesson is a real git repo, one file per content block
      doc.js              pure doc helpers: canonical JSON, manifest, block map (no git)
      ops.js              diff two docs into block operations; render commit messages (no git)
      merge.js            three-way merge by block id, field-level (no git)
      layout.js           document <-> git tree (lesson.json manifest + blocks/<blockId>.json)
      repo.js             commit, history, diff two commits, restore (bare repo, pure plumbing)
      pack.js             pack for upload; clone/fetch from a pack; find the merge base
      remote.js           calls the Worker's /git/:lessonId endpoints (pack in R2)
      sync.js             fork (= clone the repo) and merge-with-original flows
      fs.js               LightningFS — the IndexedDB filesystem the repos live on
      engine.js, load.js  the git engine, behind one dynamic import (keeps ~185 KB off the main bundle)
      useLessonGit.js     the editor's controller: setup, periodic commits, history, restore
    useImageSrc.js        resolves an image ref to a displayable src
    image.js              file reading, sizing, data-url helpers
    supabase.js           Supabase client (auth only) + supabaseEnabled flag
    auth.jsx              AuthProvider + useAuth (session, magic link, sign out)
    googleDrive.js        OAuth2 + upload the docx to Drive as a Google Doc
    turnstile.js          Cloudflare Turnstile loader + site key
    seo.js                per-page document title + Open Graph / Twitter tags
    storage.js            localStorage auto-save
    id.js                 id generation
```
