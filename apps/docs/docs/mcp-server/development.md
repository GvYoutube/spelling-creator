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
| `src/standards.md` | The authoring standard's prose half — the rules that need judgement.                               |
| `src/validate.js`  | The authoring standard's enforceable half. See [Lesson validation](/mcp-server/lesson-validation). |
| `src/api.js`       | The hub client (the same Worker endpoints the web app uses).                                       |
| `src/auth.js`      | Supabase token rotation.                                                                           |

`src/standards.md` is prose, so it is edited as a document rather than as an escaped
JavaScript string, and `src/standards.js` is only the seam that loads it. Getting a
markdown file into both runtimes takes a per-runtime resolution: `#standards-md` (a subpath
import declared in `apps/mcp/package.json`) points at `standards.workerd.js` under the
`workerd` condition, which imports the markdown as a Text module — wrangler needs the
`rules` entry in `apps/api/wrangler.jsonc` to load `.md` that way, and it matches on the
import specifier, which is why the shim names the file by a literal relative path.
Everywhere else it points at `standards.node.js`, which reads the file off disk (`src/`
ships whole in the `.mcpb` bundle, so the path holds for an installed server too).

`test/validate.test.js` is built around one lesson written exactly to the standard, which
must produce no errors and no warnings; the other cases mutate that fixture a rule at a
time. Keep it that way — a false positive blocks an author who did nothing wrong, so the
clean-lesson case is the one that matters most.
