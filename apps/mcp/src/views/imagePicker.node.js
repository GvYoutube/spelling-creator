// The Node half of `#image-picker-html` (see package.json's "imports" and
// views.js). Node has no text-module loader, so the built view is read off disk
// — it sits beside this file in src/views/, and the .mcpb bundle copies src/
// wholesale, so the path holds for an installed server too.
import { readFileSync } from "node:fs";

export default readFileSync(
  new URL("./imagePicker.html", import.meta.url),
  "utf8",
);
