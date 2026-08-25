// The Node half of `#standards-md` (see package.json's "imports" and
// standards.js). Node has no text-module loader, so the markdown is read off
// disk — it sits beside this file in src/, and the .mcpb bundle copies src/
// wholesale, so the path holds for an installed server too.
//
// The Workers half needs no shim: `#standards-md` resolves straight to
// standards.md under the "workerd" condition, and wrangler's Text module rule
// turns it into this same default-exported string.
import { readFileSync } from "node:fs";

export default readFileSync(new URL("./standards.md", import.meta.url), "utf8");
