// What a set of block operations changed, rendered the same way everywhere it is
// asked.
//
// Three places ask: a commit in the version history, a proposal's own page, and
// (through the first) a restore preview. They were never going to stay in step as
// three copies, and "what changed" is exactly the thing a reader compares between
// views — a proposal that reads differently from the commit it becomes would be
// worse than no summary at all.
//
// Both pieces take ops in the shape ops.js produces, and neither needs git: the
// operations are already derived by the time they get here, which is what lets
// the proposal page draw this without the engine loaded.

import { useTranslation } from "react-i18next";
import { Badge } from "./ui/badge.jsx";
import { describeOp } from "@spelling-creator/core/git/ops";

// The counts badged against a change. Section and title operations are
// deliberately not tallied — they are structure, they appear in the list below,
// and a chip saying "1 changed" for a renamed section next to "1 changed" for a
// rewritten question would flatten a distinction that matters.
function tally(ops) {
  const counts = { added: 0, edited: 0, removed: 0, moved: 0 };
  for (const op of ops) {
    if (op.op === "block.add") counts.added++;
    else if (op.op === "block.edit") counts.edited++;
    else if (op.op === "block.remove") counts.removed++;
    else if (op.op === "block.move") counts.moved++;
  }
  return counts;
}

// Chip colors, mapped from MUI's semantic palette onto this app's tokens —
// success/destructive already exist; "changed" borrows --primary for the
// same blue-ish "info" read, "moved" stays neutral (MUI's "default").
const CHIP_STYLES = {
  success: "border-success/40 bg-success/10 text-success",
  info: "border-primary/40 bg-primary/10 text-primary",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  default: "border-border bg-transparent text-muted-foreground",
};

/** "3 added · 1 changed · 2 removed" — the shape of a change, at a glance. */
export function ChangeChips({ ops, className = "mt-1.5" }) {
  const { t } = useTranslation("editorTools");
  const counts = tally(ops);
  const chips = [
    ["added", counts.added, "success"],
    ["changed", counts.edited, "info"],
    ["removed", counts.removed, "error"],
    ["moved", counts.moved, "default"],
  ].filter(([, n]) => n > 0);

  if (chips.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {chips.map(([label, n, color]) => (
        <Badge key={label} variant="outline" className={CHIP_STYLES[color]}>
          {n} {t(`historyDialog.chips.${label}`)}
        </Badge>
      ))}
    </div>
  );
}

/** Every operation, spelled out. */
export function ChangeList({ ops, className = "max-h-[260px]" }) {
  return (
    <ul className={`m-0 flex flex-col gap-1 overflow-y-auto pl-4 ${className}`}>
      {ops.map((op, i) => (
        <li key={i} className="list-disc text-sm text-muted-foreground">
          {/* describeOp renders "- edit text block <id>"; drop the leading
              marker, the list already provides one. */}
          {describeOp(op).replace(/^- /, "")}
        </li>
      ))}
    </ul>
  );
}
