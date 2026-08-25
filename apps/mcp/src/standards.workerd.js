// The Workers half of `#standards-md` (see package.json's "imports" and
// standards.js). wrangler's Text module rule (apps/api/wrangler.jsonc) turns
// standards.md into a default-exported string at bundle time.
//
// The rule matches on the import specifier, so the markdown has to be named by a
// literal relative path — importing `#standards-md` directly would resolve to
// the file but never match the rule. Hence this one-line shim.
import markdown from "./standards.md";

export default markdown;
