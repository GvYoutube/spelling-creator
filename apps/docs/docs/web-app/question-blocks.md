---
title: Question blocks
---

# Question blocks

Each section can hold **question blocks** alongside text and images. Pick a type
from the **Add question** menu; every type is colour-coded so it's easy to scan
the lesson at a glance. The types, their shape, and their colours live in one
place, `packages/core/src/questions.js`, so the editor and both exporters stay in sync.

| Type                     | Colour | What it captures                                                             |
| ------------------------ | ------ | ---------------------------------------------------------------------------- |
| **Number answer**        | purple | A single numeric answer, with an optional extendable list of solution steps. |
| **Single answer**        | green  | A list of options with exactly one correct choice.                           |
| **Multiple answers**     | amber  | A list of options with any number of correct choices.                        |
| **Paraphrase**           | brown  | Restate the passage in their own words. No stored answer.                    |
| **Open ended**           | pink   | A free written response.                                                     |
| **Background knowledge** | blue   | A prompt plus the prior knowledge a student needs to answer it.              |

**Multiple answers** is amber rather than the burnt orange it used to be: it
would otherwise sit too close to **Paraphrase**'s brown, and in a printed lesson
the colour is the only thing marking a question's type.

In the editor each question also shows its position within its section — `Q7`,
next to the type badge. A standard section holds fifteen of them, and the type
badge alone doesn't distinguish one from the next, so the number is what makes a
question findable again after you've scrolled away from it (see
[Navigating large lessons](./navigating-large-lessons.md#question-numbering)).
It's editor-only chrome: nothing is written into the document or the export.

A question prints as its **prompt in the colour of its type, followed by its
answer in black on the same line** — nothing is labelled or bracketed, so the
colour is what marks the type. The footer legend on every page names the types in
their colours (see [the export pipeline](./export-pipeline.md)). A question with no
recorded answer, and the free-response types (**Paraphrase** and **Open ended**),
print as the prompt alone.

Number-answer questions can also hold a list of **steps** — the worked-out
stages of solving the problem. Use **Add step** in the editor to grow the
list, and remove any row you don't need; the list starts empty since steps
are optional. Steps print as an indented numbered list under the question, and
round-trip through both JSON and DOCX import.
