// Lesson authoring standards, fed to the connecting AI assistant so it produces
// well-shaped lessons by default without the user re-explaining the rules every
// session. Developed iteratively while authoring S2C (Spelling to Communicate)
// lessons for a non-speaking or minimally-speaking speller who answers by
// pointing to letters on a letterboard — which is why answers must be short,
// unambiguous, and findable in the text.
//
// The standard itself is prose, so it lives as prose: standards.md, edited as a
// document rather than as an escaped JavaScript string. This module is only the
// seam that gets that file into both runtimes. `#standards-md` is a package
// subpath import (see package.json) resolved per-runtime: under the "workerd"
// condition it points straight at standards.md, which wrangler's Text module
// rule loads as a string (apps/api/wrangler.jsonc); everywhere else it points at
// standards.node.js, which reads the file off disk.
//
// Sent to clients as the server's `instructions` (see worker.js / stdio.js) and
// also embedded directly in create_lesson's tool description (tools.js), since
// not every MCP client surfaces server-level instructions to the model (notably
// claude.ai's connector UI doesn't). Other tools that share the same authoring
// standard (e.g. create_lesson_file) point to create_lesson's description rather
// than repeating this text. standards.md is the canonical copy of the standard —
// when it changes, update the question counts echoed in tools.js's descriptions
// and in apps/docs/docs/mcp-server/tools.md to match.
//
// That text carries the half of the standard that needs judgement. The half a
// script can decide is enforced on write by validate.js, whose error messages are
// written to be self-correcting on their own — so a client that shows the model
// none of this still produces lessons that hold the line. Keep the two in step:
// a rule stated there that validate.js also checks should describe the same thing.
import markdown from "#standards-md";

export const LESSON_STANDARDS = markdown;
