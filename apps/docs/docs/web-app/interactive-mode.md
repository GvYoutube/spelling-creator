---
title: Interactive lesson mode
sidebar_position: 5.8
---

# Interactive lesson mode

Any lesson on the hub can be **worked through** instead of read. Press **Start
lesson** on a lesson page and the lesson takes over the screen: a section's
material appears on its own, one step at a time, then that section's questions
appear one after another, each with a field to type an answer into.

At the end you get a summary of everything you wrote, and — if you're signed in —
it is saved **privately to your account**. Nobody else can read it, including the
person who wrote the lesson. See [Privacy](#privacy-who-can-read-your-answers)
below, which is the part of this feature worth being precise about.

The lesson can also be **read aloud** with the browser's built-in speech
synthesis, on the reader's own device. See
[Reading aloud](#reading-aloud-text-to-speech).

## Every existing lesson already works

There is no "interactive lesson" document type and nothing to switch on when
authoring. The walkthrough is **derived from the lesson document you already
have** (`packages/core/src/interactive.js`), so every lesson ever published works
— including ones made long before this feature existed and ones written by the
[MCP server](/mcp-server/overview). Nothing is added to a lesson to make it
playable, and a lesson stays exactly as printable as it was.

The rules that turn a document into steps:

| In the document                             | Becomes                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| A section's text, image and spelling blocks | One **content step**, holding them together in document order.          |
| Each question block                         | One **question step**, with a text field, after that section's content. |
| A section with only questions               | No content step — it opens straight on its first question.              |
| A section with nothing in it                | Nothing.                                                                |
| A lesson with no questions at all           | A read-through: every content step, no answer fields, nothing saved.    |

Questions are numbered from 1 within each section, matching the editor's `Q7`
numbering (see [Navigating large lessons](./navigating-large-lessons.md#question-numbering)).

## What it looks like

Interactive mode is **full-screen** and drawn in the app's own theme, light or
dark — as is the lesson page below it, which follows the theme too rather than
reproducing the white sheet the [DOCX/PDF export](./export-pipeline.md)
produces. What's different here is the _scale_: a surface you read and answer on
for twenty minutes gets its own treatment, so the blocks are re-rendered — prose
at reading size, images framed in the app's border and radius, spelling words as
cards you could read across a room. Only the presentation differs; the content
is the same blocks.

A progress bar across the top counts the steps and how many questions you've
answered so far.

## What it deliberately doesn't do

**It doesn't mark your answers.** A question block carries the author's own
answer, and interactive mode never shows it, never speaks it, and never compares
it against what you typed. Spelling (S2C) is about the learner producing the
response; a right/wrong verdict from a string comparison would be wrong a lot of
the time and the wrong shape of feedback even when it wasn't.

**It doesn't save partial work.** Answers are held in the browser while you work
and sent once, when you finish. A half-finished run-through is never stored as a
completed one — which is why closing mid-way asks before discarding what you've
typed.

## Privacy: who can read your answers

Only you.

- Every endpoint that touches saved answers requires a signed-in session, and
  the Worker scopes each query to `user_id = <verified caller>` — that filter is
  the only way a row is ever addressed, not a check layered on top of one.
- There is **no endpoint that returns another user's answers**. Not for the
  lesson's author, not for a moderator, not for an admin. A lesson author can see
  that their lesson exists and who commented on it; they cannot see who worked
  through it or what they wrote.
- The `lesson_responses` table has no public read policy, unlike `lessons`,
  `comments` and `ratings`.
- Answers are **not** run through the profanity filter that
  [comments](./lesson-hub-and-accounts.md) go through. There's no audience to
  protect: nobody but their author ever reads them.

Your saved run-throughs appear in a **Your answers** panel on the lesson page,
below the lesson itself and above the comments. It renders for you and nobody
else, and each one can be deleted outright.

Signed out, you can still work through a lesson start to finish and see your
summary — there's just no account to save it to, and the summary says so.

## Reading aloud (text-to-speech)

The speaker button in the top bar turns on **read aloud**, using the browser's
[Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API)
(`speechSynthesis`). Like [lesson summaries](./lesson-summaries.md), this runs
entirely on the reader's own device: no Worker call, no API key, no cost, and the
lesson text never leaves the machine. Unlike summaries, it needs no special
hardware and is supported across current browsers — but it's still probed for
rather than assumed, and where it's missing the controls aren't rendered at all.

With it on:

- each step is read as it appears — the section name, then the prose, image
  captions, or the question prompt;
- a **replay** button re-reads the current step (and turns into a stop button
  while it's speaking);
- every **spelling word gets its own speaker button**, because hearing one word
  again is the commonest thing a learner wants and a different job from hearing
  the whole step;
- the settings popover picks a **voice** from the ones the browser offers and a
  **pace** from 0.7× to 1.5×.

A question's answer is never spoken, for the same reason it's never shown.

Your choice of on/off, voice and pace is remembered in `localStorage`, so someone
who needs speech doesn't re-enable it on every lesson. On a browser with no
speech synthesis the controls aren't rendered at all, rather than offering a
button that can't work.

Three platform quirks are handled in `apps/web/src/lib/useSpeech.js`: voices load
asynchronously (`voiceschanged`), Chromium cuts off a single utterance after
about 15 seconds (so text is split into sentence-sized chunks and queued), and
`cancel()` isn't synchronous (so a new utterance is deferred a tick after one).

## Worker endpoints

| Method & path                        | Auth                    | Response                                                                                              |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /lessons/:id/responses`         | `Bearer <Supabase JWT>` | `{ "responses": [{ id, lessonId, answers, completedAt }] }` — **the caller's own only**, newest first |
| `POST /lessons/:id/responses`        | `Bearer <Supabase JWT>` | `{ "response": { id, lessonId, answers, completedAt } }`                                              |
| `DELETE /lessons/:id/responses/:rid` | `Bearer <Supabase JWT>` | `{ "ok": true }` — the caller's own only; else `404`                                                  |

- `POST` body is `{ answers }`, where `answers` is one entry per question:
  `{ blockId, sectionId, sectionName, questionType, prompt, answer }`. The
  Worker normalises every field to a string of known maximum length and drops
  anything else, so the stored `jsonb` can only hold that shape.
- The **prompt is snapshotted** alongside the answer on purpose: a saved
  run-through has to stay readable after the lesson is edited, re-ordered, or has
  that question deleted.
- Skipped questions are stored as blank answers rather than dropped, so the set
  still says which questions were asked.
- Limits (shared between browser and Worker in
  `packages/core/src/interactive.js`): 5,000 characters per answer and 500
  answers per submission.
- You may keep **20 saved run-throughs of any one lesson**. Past that a `POST` is
  rejected with `409` and a message asking you to delete an older one — rejected
  rather than silently pruning the oldest, for the same reason the
  [draft cap](./lesson-hub-and-accounts.md) is: they're the user's own answers,
  and quietly deleting them to make room isn't ours to decide.
- `POST` also checks the lesson is one the caller could have read in the first
  place: published and not shadowbanned, or theirs / trusted / moderated.

## Supabase schema

```sql
create table if not exists public.lesson_responses (
  id           uuid primary key default gen_random_uuid(),
  lesson_id    uuid not null references public.lessons (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  answers      jsonb not null,
  completed_at timestamptz not null default now()
);

create index if not exists lesson_responses_user_lesson_idx
  on public.lesson_responses (user_id, lesson_id, completed_at desc);

-- No public read policy, unlike lessons/comments/ratings: this data is private.
alter table public.lesson_responses enable row level security;
```

The full schema, with the reasoning in comments, is `apps/api/schema.sql`.

## Where the code lives

| File                                            | What it does                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core/src/interactive.js`              | Turns a document into steps; shared limits and validation.         |
| `packages/core/src/lessonResponses.js`          | Client for the three endpoints above.                              |
| `apps/api/src/routes/lessonResponses.js`        | The endpoints, and the privacy scoping.                            |
| `apps/web/src/components/InteractiveLesson.jsx` | The full-screen walkthrough.                                       |
| `apps/web/src/components/MyLessonAnswers.jsx`   | The private "Your answers" panel on the lesson page.               |
| `apps/web/src/lib/useSpeech.js`                 | Web Speech API wrapper, preferences, and the platform workarounds. |
