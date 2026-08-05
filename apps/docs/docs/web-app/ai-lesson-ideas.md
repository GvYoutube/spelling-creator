---
title: AI lesson ideas
sidebar_position: 5.5
---

# AI lesson ideas

When you're starting from a blank document, **AI lesson ideas**
(`AiLessonIdeaDialog.jsx`) suggests a batch of lesson **topics** to pick from —
each a short title plus a one-line description — rather than writing the lesson
body. Pick one and it seeds a new lesson you then flesh out with the editor and
the other AI helpers.

The suggestions are tailored to the **age range** the lesson is pitched at (see
`src/lib/ageRanges.js`), which is stored on the lesson document.

## How it works

Like the [AI text](./ai-text-suggestions.md) and
[AI question](./ai-question-suggestions.md) helpers, it goes through the same
Turnstile-verified Worker (`apps/api`):

1. A [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) widget
   verifies the request.
2. The verified token and the chosen `ageRange` are POSTed to the Worker with
   `mode: "lessonIdea"`.
3. The Worker re-checks the token server-side, asks the model for a batch of
   ideas, and returns them as `{ "ideas": [{ "title", "description" }] }`.

The frontend wrapper is `suggestLessonIdeas()` in `@spelling-creator/core/aiSuggest`. This
feature needs the same `VITE_API_URL` / `VITE_TURNSTILE_SITE_KEY` as the other AI
helpers (see [Getting started](./getting-started.md)).

A dismissable [first-lesson wizard](./overview.md) (`FirstLessonWizard.jsx`) — a
floating, non-modal walkthrough that auto-shows once for newcomers and can be
reopened from the editor's help button — points people at this and the other
authoring tools.
