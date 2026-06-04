---
title: Tools
sidebar_position: 2
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

## Lesson shape the assistant fills

A lesson is **sections** of **blocks**. Block types:

- **`text`** — a paragraph. Put words you're teaching the spelling of in **ALL
  CAPS**; the app highlights them as spelling words.
- **`spelling`** — an explicit word list: `{ "type": "spelling", "words": ["BECAUSE", "FRIEND"] }`.
- **`question`** — a quiz question with a `questionType`:
  - `number` → `answer` (numeric)
  - `single` → `answer` (one text answer)
  - `multiple` → `answers` (array of accepted answers)
  - `open` → `exampleAnswer` (free response)
  - `background` → `background` + `answer` (needs prior knowledge)

Image blocks aren't supported over MCP yet (they need a separate binary upload).
