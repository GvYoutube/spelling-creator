---
title: Tools
---

# Tools

| Tool                   | What it does                                                                  |
| ---------------------- | ----------------------------------------------------------------------------- |
| `whoami`               | Confirm the session is valid and show the publishing display name.            |
| `create_lesson`        | Build and save a new lesson (draft by default; `published: true` to share).   |
| `patch_lesson`         | Edit a lesson with a small diff (id-addressed ops) instead of a full replace. |
| `update_lesson`        | Replace a lesson's whole title/content (author only).                         |
| `get_lesson`           | Fetch one lesson with its full content (read before editing / as a template). |
| `list_my_lessons`      | List your own lessons (drafts + published).                                   |
| `list_hub_lessons`     | Browse published lessons for inspiration / de-duplication.                    |
| `set_lesson_published` | Toggle a lesson between public and private draft.                             |
| `delete_lesson`        | Permanently delete one of your lessons.                                       |
| `search_images`        | Search Wikimedia Commons for freely-licensed images to illustrate a lesson.   |
| `add_image`            | Download a searched image and insert it as an image block in a lesson.        |

## Editing a lesson: patch vs. replace

For tweaks, prefer **`patch_lesson`** — `get_lesson` to read the current section/block
**ids**, then send a small list of operations that address those ids, e.g.:

```json
{
  "id": "…",
  "operations": [
    { "op": "set_section_name", "sectionId": "…", "name": "Volcano basics" },
    {
      "op": "replace_block",
      "blockId": "…",
      "block": { "type": "text", "text": "Magma RISES." }
    },
    {
      "op": "add_block",
      "sectionId": "…",
      "block": {
        "type": "question",
        "questionType": "single",
        "prompt": "What rises?",
        "answer": "magma"
      }
    }
  ]
}
```

Ops: `set_title`, `set_section_name`, `add_section`, `remove_section`, `move_section`,
`add_block`, `replace_block` (keeps the block id), `remove_block`, `move_block`. The
server fetches the lesson, applies the ops in order, and saves the result (the hub API
itself only does full replaces, so the diff is applied server-side). Use `update_lesson`
when you're rewriting the whole lesson anyway.

There is a second reason to prefer patching. Both tools check the result against the
authoring standard, but `patch_lesson` holds the caller only to the defects its edit
introduced, whereas `update_lesson` replaces the whole document and so owns everything in
it — including problems inherited from the lesson it fetched. See
[Lesson validation](/mcp-server/lesson-validation).

## Lesson shape the assistant fills

By default (unless you ask for something different), the assistant builds **6 sections**, each
one an optional image, 2 text paragraphs, 4 spelling words, and 15 questions in a fixed order —
covering verbatim-in-text, fill-in-the-blank, word-problem, single-word retrieval,
background-knowledge, and open-ended question types. This default (and the rest of the authoring conventions — spelling-
word rules, math `steps`, image placement, tone) is sent to the connecting assistant as the
server's MCP `instructions`, so most clients apply it automatically. Not every client surfaces
server `instructions` to the model — notably claude.ai's connector UI doesn't — so the full
standard is also embedded directly in `create_lesson`'s tool description (`create_lesson_file`
just points to it, rather than repeating it) to make sure it reaches the model either way.

The half of the standard a script can decide doesn't rely on the model having read anything:
every tool that writes a lesson validates it first and **rejects** the write on a grounding,
spelling-word or uniqueness failure, with a message naming the section, the value and the fix.
Softer shape problems come back as a `warnings` array on the saved result. `skipValidation: true`
turns the errors off for a user who deliberately wants something the standard forbids. See
[Lesson validation](/mcp-server/lesson-validation) for every code.

A lesson is **sections** of **blocks**. Block types:

- **`text`** — a paragraph. Put words you're teaching the spelling of in **ALL
  CAPS**; the app highlights them as spelling words.
- **`spelling`** — an explicit word list: `{ "type": "spelling", "words": ["BECAUSE", "FRIEND"] }`.
- **`question`** — a quiz question with a `questionType`:
  - `number` → `answer` (numeric), plus optional `steps` (array of worked-solution steps, in order)
  - `single` → `answer` (one text answer)
  - `multiple` → `answers` (array of accepted answers)
  - `open` → free response (no answer field; just the `prompt`)
  - `background` → `background` + `answer` (needs prior knowledge)

- **`image`** — a picture. Don't write these by hand; use `search_images` to find a
  freely-licensed Wikimedia Commons image, then `add_image` with its `ref` to download
  the bytes, store them, and insert the block. The licence attribution is set as the
  caption automatically.

## Placing an image

`add_image` needs somewhere to put the block. In order of precedence:

1. **`afterBlockId`** — insert directly after a specific block id (from `get_lesson`).
   This is the most reliable way to place an image next to the content it illustrates,
   since it pins both the section and the position without any index arithmetic.
2. **`sectionId`** / **`sectionIndex`** + optional **`index`** — target a section
   explicitly and, optionally, a 0-based position within it.
3. If none of the above are given, the image is inserted at the end of the **last**
   section's prose, just before any trailing question block(s) — never buried after
   the quiz.
