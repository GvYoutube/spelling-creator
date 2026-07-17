// Settling a merge.
//
// Most of a merge needs no input: a block only one side touched is taken from
// that side, and a block both sides touched in *different fields* — one changed
// the caption, the other the width — is merged field by field so both edits
// survive. That happens silently, and is reported here as a summary.
//
// What's left is the genuinely contested: the same field of the same block, given
// two different values by two people. No rule can pick between those, so we ask.
// One card per contested block, both values side by side, three ways out:
//
//   Mine        keep our value
//   Theirs      take the original's
//   Keep both   keep ours AND add theirs as a second block (nothing is lost)
//
// See lib/git/merge.js for the merge itself; this component only chooses.

import { useState } from "react";
import {
  GitMergeIcon,
  CircleCheckIcon,
  TriangleAlertIcon,
  InfoIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog.jsx";
import { Button } from "./ui/button.jsx";
import { Badge } from "./ui/badge.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.jsx";
import { cn } from "../lib/utils.js";
import { questionMeta } from "../lib/questions.js";

/** A contested value, rendered readably whatever shape it has. */
function ValueText({ value }) {
  if (value === null || value === undefined || value === "") {
    return <p className="text-sm text-muted-foreground italic">(empty)</p>;
  }
  if (Array.isArray(value)) {
    // Spelling words and multiple-choice answers are [{ id, text }].
    const items = value.map((v) => (v && typeof v === "object" ? v.text : v));
    return <p className="text-sm">{items.join(", ")}</p>;
  }
  if (typeof value === "object") {
    return <p className="font-mono text-xs">{JSON.stringify(value)}</p>;
  }
  return <p className="text-sm">{String(value)}</p>;
}

/** A human name for the block a conflict is about. */
function blockLabel(block) {
  if (!block) return "block";
  if (block.type === "question") {
    return `${questionMeta(block.questionType).short} question`;
  }
  if (block.type === "spelling") return "spelling list";
  if (block.type === "image") return "image";
  return "text block";
}

// One side of a contested field, in a tinted panel.
function Side({ label, value, chosen }) {
  return (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-md border p-2.5",
        chosen ? "border-primary bg-accent" : "border-border bg-transparent",
      )}
    >
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <ValueText value={value} />
    </div>
  );
}

function ConflictCard({ conflict, choice, onChoose, theirName }) {
  const block = conflict.ours || conflict.theirs;
  const deleted = conflict.kind === "delete/edit";

  return (
    <div className="rounded-md border border-border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{blockLabel(block)}</span>
          <Badge
            variant="outline"
            className={cn(deleted && "border-focus/40 bg-focus/10 text-focus")}
          >
            {deleted
              ? conflict.deletedBy === "theirs"
                ? `deleted in ${theirName}`
                : "you deleted this"
              : conflict.fields.map((f) => f.field).join(", ")}
          </Badge>
        </div>

        <ToggleGroup
          type="single"
          size="sm"
          value={choice}
          onValueChange={(next) => next && onChoose(next)}
        >
          <ToggleGroupItem value="ours">
            {deleted ? "Keep it" : "Mine"}
          </ToggleGroupItem>
          <ToggleGroupItem value="theirs">
            {deleted ? "Delete it" : "Theirs"}
          </ToggleGroupItem>
          {!deleted && (
            <ToggleGroupItem value="both">Keep both</ToggleGroupItem>
          )}
        </ToggleGroup>
      </div>

      {deleted ? (
        <p className="text-sm text-muted-foreground">
          {conflict.deletedBy === "theirs"
            ? `You edited this block; ${theirName} deleted it. Keeping it preserves your edit.`
            : `You deleted this block; ${theirName} edited it. Keeping it restores their version.`}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {conflict.fields.map((field) => (
            <div key={field.field}>
              <span className="mb-1 block text-xs text-muted-foreground">
                {field.field}
              </span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Side
                  label="Mine"
                  value={field.ours}
                  chosen={choice === "ours" || choice === "both"}
                />
                <Side
                  label={theirName}
                  value={field.theirs}
                  chosen={choice === "theirs" || choice === "both"}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * @param {object}   props.prepared  The result of prepareMerge (doc, conflicts, auto).
 * @param {string}   props.theirName What to call the other side (usually the original's title).
 * @param {"pull"|"contribute"|"publish"} props.intent  What happens once it's settled.
 * @param {Function} props.onConfirm Called with the { blockId: choice } map.
 */
export default function MergeDialog({
  open,
  onClose,
  prepared,
  theirName = "the original",
  intent = "pull",
  onConfirm,
  busy,
}) {
  // Default every conflict to keeping our own work — the safe assumption is that
  // the user's own edits stand unless they say otherwise.
  const [choices, setChoices] = useState({});

  if (!prepared) return null;
  const { conflicts, auto } = prepared;

  // A contribution writes to *someone else's* lesson, so say so plainly rather
  // than letting "Merge" imply it only touches your own copy.
  const contributing = intent === "contribute";
  const confirmLabel = busy
    ? contributing
      ? "Merging back..."
      : "Merging..."
    : contributing
      ? `Merge back into ${theirName}`
      : "Merge";

  const choiceFor = (blockId) => choices[blockId] || "ours";
  const choose = (blockId, value) =>
    setChoices((prev) => ({ ...prev, [blockId]: value }));

  const autoCount =
    auto.added.length +
    auto.tookTheirs.length +
    auto.merged.length +
    auto.removed.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose?.();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMergeIcon className="size-4" />
            <span>
              {contributing
                ? `Merge your changes back into ${theirName}`
                : `Merge changes from ${theirName}`}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto border-t border-border pt-4">
          {contributing && (
            <Alert className="border-focus/40 bg-focus/10 text-focus">
              <TriangleAlertIcon />
              <AlertDescription className="text-focus">
                This updates{" "}
                <strong className="font-medium">{theirName}</strong> itself, for
                everyone — you are a trusted collaborator on it. Its latest
                changes are merged in first, so nothing its author has done
                since you forked is lost, and they&apos;ll be notified.
              </AlertDescription>
            </Alert>
          )}
          {autoCount > 0 && (
            <Alert className="border-success/40 bg-success/10 text-success">
              <CircleCheckIcon />
              <AlertDescription className="text-success">
                <p className="mb-1">Merged automatically:</p>
                <ul className="ml-4 list-disc">
                  {auto.added.length > 0 && (
                    <li>
                      {auto.added.length} new block(s) from {theirName}
                    </li>
                  )}
                  {auto.tookTheirs.length > 0 && (
                    <li>
                      {auto.tookTheirs.length} block(s) they updated (you
                      hadn&apos;t touched)
                    </li>
                  )}
                  {auto.merged.length > 0 && (
                    <li>
                      {auto.merged.length} block(s) you both edited — in
                      different fields, so{" "}
                      <strong className="font-medium">
                        both sets of edits were kept
                      </strong>
                    </li>
                  )}
                  {auto.removed.length > 0 && (
                    <li>{auto.removed.length} block(s) removed</li>
                  )}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {conflicts.length === 0 ? (
            <Alert>
              <InfoIcon />
              <AlertDescription>
                Nothing is in conflict — the whole merge resolved on its own.
                Confirm to apply it.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {conflicts.length === 1
                  ? "One block was edited on both sides in the same place. Choose which to keep."
                  : `${conflicts.length} blocks were edited on both sides in the same place. Choose which to keep.`}
              </p>
              <div className="flex flex-col gap-4">
                {conflicts.map((conflict) => (
                  <ConflictCard
                    key={conflict.blockId}
                    conflict={conflict}
                    choice={choiceFor(conflict.blockId)}
                    onChoose={(value) => choose(conflict.blockId, value)}
                    theirName={theirName}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(choices)}
            disabled={busy}
          >
            <GitMergeIcon data-icon="inline-start" />
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
