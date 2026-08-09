---
title: Development
---

# Development

```bash
pnpm --filter @spelling-creator/mcp start   # run the stdio server directly
pnpm --filter @spelling-creator/mcp test    # doc-builder + auth + tool-surface + validation tests
```

## Where things live

| File               | Responsibility                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `src/tools.js`     | Tool definitions and handlers, transport-agnostic.                                                 |
| `src/doc.js`       | Builds the canonical editor document; throws on input it can't turn into one.                      |
| `src/patch.js`     | Applies id-addressed edit operations to an existing document.                                      |
| `src/standards.js` | The authoring standard's prose half — the rules that need judgement.                               |
| `src/validate.js`  | The authoring standard's enforceable half. See [Lesson validation](/mcp-server/lesson-validation). |
| `src/api.js`       | The hub client (the same Worker endpoints the web app uses).                                       |
| `src/auth.js`      | Supabase token rotation.                                                                           |

`test/validate.test.js` is built around one lesson written exactly to the standard, which
must produce no errors and no warnings; the other cases mutate that fixture a rule at a
time. Keep it that way — a false positive blocks an author who did nothing wrong, so the
clean-lesson case is the one that matters most.
