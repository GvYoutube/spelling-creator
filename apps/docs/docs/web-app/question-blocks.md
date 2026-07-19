---
title: Question blocks
sidebar_position: 3
---

# Question blocks

Each section can hold **question blocks** alongside text and images. Pick a type
from the **Add question** menu; every type is colour-coded so it's easy to scan
the lesson at a glance. The types, their shape, and their colours live in one
place, `src/lib/questions.js`, so the editor and both exporters stay in sync.

| Type                     | Colour | What it captures                                                             |
| ------------------------ | ------ | ---------------------------------------------------------------------------- |
| **Number answer**        | purple | A single numeric answer, with an optional extendable list of solution steps. |
| **Single answer**        | green  | A list of options with exactly one correct choice.                           |
| **Multiple answers**     | orange | A list of options with any number of correct choices.                        |
| **Open ended**           | pink   | A free written response (exported with a blank line to write the answer on). |
| **Background knowledge** | blue   | A prompt plus the prior knowledge a student needs to answer it.              |

Questions are rendered into the DOCX (and therefore the printed PDF) with their
prompt, options, answer markers, and blank lines, so the exported lesson is ready
to print and use.

Number-answer questions can also hold a list of **steps** — the worked-out
stages of solving the problem. Use **Add step** in the editor to grow the
list, and remove any row you don't need; the list starts empty since steps
are optional. Steps are shown under the answer in the lesson preview and are
exported to DOCX/PDF as a numbered "Steps:" list, and round-trip through both
JSON and DOCX import.
