---
title: Lesson validation
sidebar_position: 3
---

# Lesson validation

Every tool that writes a lesson — `create_lesson`, `create_lesson_file`, `update_lesson`
and `patch_lesson` — checks it against the authoring standard first. **Errors reject the
write; warnings ride along with a successful one.**

The point of validating rather than only documenting is that the standard then holds even
when the model never read it. Server `instructions` are optional in the MCP spec and some
clients drop them (claude.ai's connector UI is the notable one), and a tool description is
advice the model may or may not follow. Validation does not depend on either.

The split between the two halves of the standard lives in two files:

| File                        | Holds                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mcp/src/standards.js` | The rules that need judgement — tone, difficulty, what makes a tight open easy. Sent as MCP `instructions` and embedded in `create_lesson`'s description. |
| `apps/mcp/src/validate.js`  | The rules a script can decide. Enforced on write, whatever the client showed the model.                                                                   |

Keep them in step: a rule stated in one that the other also covers should describe the
same thing.

## Errors — the write is rejected

| Code                      | What tripped it                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E_GROUNDING_SINGLE`      | A green (`single`) answer does not appear, word for word, in its own section's passage.                                                                             |
| `E_GROUNDING_MULTIPLE`    | A multi-word orange (`multiple`) answer is not in its own section's passage.                                                                                        |
| `E_ORANGE_PARAPHRASED`    | A single-word orange answer is not in the passage — usually paraphrase ("HOT" for "superheated") or general knowledge, which belongs in a `background` question.    |
| `E_GROUNDING_NUMBER_FILL` | A fill-in-the-blank `number` answer (one with no `steps`) is not in the passage.                                                                                    |
| `E_BACKGROUND_IN_TEXT`    | A blue (`background`) answer **does** appear in its own passage, defeating the point of the type.                                                                   |
| `E_BACKGROUND_NO_CONTEXT` | A `background` question has no `background` field.                                                                                                                  |
| `E_SPELLING_LENGTH`       | A spelling word is outside 6–9 letters.                                                                                                                             |
| `E_SPELLING_DUPLICATE`    | A spelling word is used in two sections (or twice in one).                                                                                                          |
| `E_SPELLING_COLLISION`    | A spelling word appears **inside** an answer anywhere in the lesson — `PRISON` within "the prisoner's dilemma". Matched as a raw substring, which is the point.     |
| `E_ANSWER_WORD_REUSED`    | The same answer word answers two different questions, anywhere in the lesson and at any length. Also fires when a one-word answer reappears inside a longer answer. |
| `E_NUMBER_DUPLICATE`      | Two questions resolve to the same number.                                                                                                                           |
| `E_OPEN_HAS_ANSWER`       | An `open` question carries `answer`, `answers` or `exampleAnswer`.                                                                                                  |
| `E_RETIRED_STEM`          | A pink question uses the retired "…one word that comes to mind…" stem.                                                                                              |

A rejection names the section, the offending value and the fix, because the model reads it
and resubmits — `"validation failed"` buys a guess, a specific message buys a correction in
one round trip. Up to 25 are listed at a time.

## Warnings — saved, and reported back

Returned as a `warnings` array on the successful result:

```json
{
  "id": "…",
  "url": "…",
  "warnings": [
    {
      "code": "W_NUMBER_NO_STEPS",
      "section": 3,
      "message": "Section 3 \"Deserts\": no purple question carries `steps`. …"
    }
  ]
}
```

| Code                    | What it flags                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `W_SECTION_COUNT`       | The lesson isn't 6 sections. Lesson-wide, so it carries no `section`.                                                                           |
| `W_QUESTION_SHAPE`      | A section's question types or order differ from 3 `single`, 2 `number`, 2 `multiple`, 1 `background`, 7 `open`.                                 |
| `W_NO_QUESTION`         | A section has no questions at all.                                                                                                              |
| `W_OPEN_SPLIT`          | A section's 7 pink questions don't read as 4 tight opens followed by 3 extended ones.                                                           |
| `W_ORANGE_MULTIWORD`    | An orange accepted answer is more than one word.                                                                                                |
| `W_ORANGE_ANSWER_COUNT` | An orange question accepts fewer than 2 or more than 4 answers.                                                                                 |
| `W_SPELLING_COUNT`      | A section doesn't have exactly 4 spelling words.                                                                                                |
| `W_NUMBER_NO_STEPS`     | A section's word problem has no `steps`.                                                                                                        |
| `W_SPELLING_IN_CAPS`    | A spelling word is also ALL-CAPS learning vocabulary in the same passage. A warning rather than an error because acronyms trip it legitimately. |

These are warnings and not errors because a legitimate lesson can trip each one: a user who
asks for four sections gets `W_SECTION_COUNT` and should not be blocked by it.

## `skipValidation`

Every writing tool takes `skipValidation: true`, which turns the **errors** off (and with
them the warnings — nothing is checked). It exists for the user who deliberately wants a
lesson the standard forbids, not as a way around a defect that should be fixed.

## Patching an existing lesson

`patch_lesson` validates the lesson **before** and **after** the edit and holds the caller
only to the difference. Without that, a one-line tweak to a lesson written in the web
editor — or written before these rules existed — would be blocked by defects the patch
never touched and the assistant may have no mandate to change.

Findings are matched on the defect's identity (its code plus the offending value) rather
than its message, so inserting or moving a section doesn't make every later finding look
new.

`update_lesson` replaces the whole document, so it gets no such exemption: whatever the
result contains, the caller sent. That is a reason to prefer `patch_lesson` for small
edits.

## Comparison rules

Text is normalised before any comparison — uppercased, punctuation dropped, whitespace
collapsed. Two details matter and both caused false failures before they were handled:

- **Thousands separators.** The passage says `3,776` and the answer field holds `3776`.
  Both normalise to `3776`.
- **Decimal points.** `112.5` has to survive the punctuation strip as one token, while the
  full stop in `MAGMA.` must not.

Grounding uses **whole-word** matching, so `ASH` is not found inside `WASHED`. The spelling
collision check deliberately uses **raw substring** matching instead, because `PRISON`
really is inside `PRISONER'S`.

Passages are flattened out of rich text first, so a lesson round-tripped through the web
editor (which stores HTML) is compared on its words rather than its markup.
