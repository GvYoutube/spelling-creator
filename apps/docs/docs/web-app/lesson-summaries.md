---
title: Lesson summaries (on-device AI)
---

# Lesson summaries (on-device AI)

A published lesson can be summarised **on the reader's own machine**, with no
server involved. The lesson page shows a **Summary** card above the lesson body:
press **Summarise** and a few bullet points appear, streamed in as the model
writes them, so a teacher can tell at a glance whether the lesson suits their
class before reading it end to end.

This is the odd one out among the AI features. The
[text](./ai-text-suggestions.md), [question](./ai-question-suggestions.md) and
[lesson idea](./ai-lesson-ideas.md) helpers all go through the Turnstile-verified
Worker in `apps/api`, which calls a hosted model and costs money per request.
Summaries use the browser's **[Summarizer API](https://developer.mozilla.org/en-US/docs/Web/API/Summarizer_API)**
instead: the model ships with the browser and runs locally, so there's no Worker
call, no Turnstile widget, no API key, no rate limit and no cost — and the lesson
text never leaves the reader's device.

The catch is that hardly anyone can run it yet.

## Availability — the feature hides itself

The Summarizer API is **Chromium-only** (Chrome/Edge 138+, desktop), and even
there the browser refuses to run it unless the machine clears a hardware bar
(enough free disk space for the model, enough VRAM, and a non-metered connection
for the one-time download). Firefox and Safari don't ship it at all.

So the card is **capability-gated**: on mount it probes
`Summarizer.availability()`, and if the answer is anything other than usable it
renders **nothing at all** — no button, no "your browser doesn't support this"
notice. A reader who can't use the feature never learns it exists, which beats
showing them a button that can't work.

`availability()` answers with one of four states, and the card reacts to each:

| State          | What it means                                                | What the card does                                                               |
| -------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `available`    | The model is downloaded and ready.                           | Summarises immediately on click.                                                 |
| `downloadable` | Supported, but the model must be fetched first.              | Shows a heads-up before the click, then a real progress bar during the download. |
| `downloading`  | Supported; a download is already running.                    | Same as `downloadable`.                                                          |
| `unavailable`  | No API, unsupported options, or hardware below the minimums. | **Renders nothing.**                                                             |

Everything in `@spelling-creator/core/browser/summarizer` **fails closed**: a missing API, unsupported
options, or a probe that throws all collapse to `"unavailable"`, so a browser that
half-implements the API can't produce a broken card.

The card also hides on lessons with **less than `MIN_SUMMARY_CHARS` (400)** of
text — below that the summary would be about as long as the lesson.

## How it works

```
LessonPage.jsx
  └── LessonSummary.jsx      the card: probe, controls, progress, streamed output
        └── core/browser/summarizer  the API wrapper (no React, fails closed)
```

1. **Probe.** On mount, `summarizerAvailability()` asks the browser whether it can
   summarise. Anything but a usable state → the card doesn't render.
2. **Click.** `createSummarizer()` opens a session. This _must_ happen from a
   click: the spec requires
   [transient activation](https://developer.mozilla.org/en-US/docs/Glossary/Transient_activation),
   so a summary can never be kicked off automatically on page load.
3. **Download (first run only).** If the model isn't on the machine yet, the
   session's `monitor` reports `downloadprogress` events and the card shows a
   determinate progress bar. This is a one-time cost per device, not per lesson.
4. **Trim to quota.** A model session has a finite input budget (`inputQuota`). A
   long lesson can overrun it, which would make the summary throw. `fitToQuota()`
   measures the text with `measureInputUsage()` and, if it's over, scales it down
   to fit — so a long lesson gets a summary of its first part (the card says so)
   rather than an error.
5. **Stream.** `summarizeStreaming()` yields the summary in chunks, which the card
   appends as they arrive. A [skeleton](./overview.md) covers the gap between the
   click and the first chunk; the summary then writes itself into place.
6. **Clean up.** Leaving the page (or starting another run) aborts the in-flight
   request and calls `destroy()` on the session to free the model.

## What the reader can change

Two dropdowns map onto the API's own options:

- **Style** → `type`: **Key points** (default, a bulleted list), **TL;DR**,
  **Teaser**, **Headline**.
- **Length** → `length`: **Short** (default), **Medium**, **Long** — relative
  sizes, not word counts.

Changing either clears the current summary and returns the card to its resting
state, so what's on screen always matches the controls. The next click regenerates
(and supplies the transient activation the new session needs).

The model is asked for **markdown**, and "key points" comes back as a bullet list.
Rather than pull in a markdown library for the handful of constructs a summary can
contain, `LessonSummary.jsx` renders the subset we actually get — bullets,
headings, paragraphs, bold and italic — falling back to plain text for anything
else. A model that ignores `format` and returns prose still renders correctly.

## Input and prompting

`lessonSummaryText(doc)` (in `@spelling-creator/core/browser/summarizer`) turns the lesson document
into the text handed to the model. It deliberately **isn't** `lessonPlainText()`
(the flattened prose used for the page's [SEO description](./pages-and-routing.md)):
here the structure is the point, so it keeps the title and section headings as
markdown headings, and labels question prompts and spelling word lists so a bare
list of words doesn't read as body text. Image captions are left out — they're
usually attribution boilerplate.

A `sharedContext` string tells the model it's looking at a spelling lesson written
for a class, and that it's summarising for another teacher deciding whether to use
it. Without it, a lesson full of question prompts and word lists reads to the model
like a worksheet to fill in rather than a lesson to describe.

The language options (`expectedInputLanguages` / `outputLanguage`) are left unset
on purpose: naming a language the local model doesn't have makes `create()` throw,
whereas omitting them lets the browser detect the lesson's language and reply in
it.

## Testing it

You need Chrome or Edge 138+ on a desktop machine that meets the
[hardware requirements](https://developer.mozilla.org/en-US/docs/Web/API/Summarizer_API#browser_compatibility).
Check what your browser thinks from the devtools console:

```js
await Summarizer.availability();
// "available" | "downloadable" | "downloading" | "unavailable"
```

If it returns `"unavailable"`, the card is _supposed_ to be invisible — that's the
feature working, not a bug. On a machine that can't run it, you can still exercise
the card by stubbing the global before the lesson page mounts:

```js
window.Summarizer = {
  async availability() {
    return "available";
  },
  async create() {
    return {
      summarizeStreaming: () => ReadableStream.from(["* A key point\n"]),
      destroy() {},
    };
  },
};
```

## Trust

The card carries a standing caveat — the summary is generated on the reader's
device by their browser's built-in AI, it can be wrong, and the lesson itself is
the source of truth. When a lesson had to be trimmed to fit the model's input
budget, the caveat says that instead, so nobody mistakes a summary of the first
half for a summary of the whole.
