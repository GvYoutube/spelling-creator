// The lesson's version history: every commit its repository holds, newest first,
// and what each one changed — expressed in blocks, not in files or diff hunks.
//
// The user never sees git. They see "Edit 1 question, add 1 image", a time, and a
// button to go back to that version. What makes that possible is the repo layout
// (one file per block, named by its id — see lib/git/layout.js): the change
// between two commits is recoverable exactly, per block, without guessing.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitMergeIcon, HistoryIcon, RotateCcwIcon, XIcon } from "lucide-react";
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
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import { HistorySkeleton } from "./Skeletons.jsx";
import { cn } from "../lib/utils.js";
import { describeOp } from "@spelling-creator/core/git/ops";
import i18n from "../lib/i18n.js";

/** "just now" / "12 minutes ago" / "3 days ago" — then fall back to a date. */
export function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 45) return i18n.t("editorTools:timeAgo.justNow");

  const units = [
    ["minute", 60],
    ["hour", 60],
    ["day", 24],
  ];
  let value = seconds / 60;
  let unit = "minute";
  for (let i = 0; i < units.length - 1; i++) {
    if (value < units[i + 1][1]) break;
    value /= units[i + 1][1];
    unit = units[i + 1][0];
  }
  // Floor, but never to zero: 45–59s is past "just now" yet floors to 0 minutes,
  // which would read as the nonsensical "0 minutes ago".
  const rounded = Math.max(1, Math.floor(value));
  if (unit === "day" && rounded > 6) {
    return new Date(ts).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    });
  }
  const unitKey =
    unit === "minute" ? "minutes" : unit === "hour" ? "hours" : "days";
  return i18n.t(`editorTools:timeAgo.${unitKey}`, { count: rounded });
}

// The counts badged against a commit, derived from its ops.
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

function ChangeChips({ ops }) {
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
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {chips.map(([label, n, color]) => (
        <Badge key={label} variant="outline" className={CHIP_STYLES[color]}>
          {n} {t(`historyDialog.chips.${label}`)}
        </Badge>
      ))}
    </div>
  );
}

/**
 * @param {object}   props.git       The useLessonGit controller.
 * @param {Function} props.onRestore Called with the restored doc; the editor adopts it.
 */
export default function HistoryDialog({ open, onClose, git, onRestore }) {
  const { t } = useTranslation("editorTools");
  const [commits, setCommits] = useState(null); // null = still loading
  const [selected, setSelected] = useState(null); // oid
  const [detail, setDetail] = useState(null); // ops of the selected commit
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState(null);

  const { loadHistory, diffFor, restore, pending } = git;

  // Re-read the history each time the dialog opens: the editor has very likely
  // committed since it was last closed.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setCommits(null);
    setSelected(null);
    setDetail(null);
    setError(null);

    loadHistory().then((list) => {
      if (cancelled) return;
      setCommits(list);
      if (list.length > 0) setSelected(list[0].oid);
    });

    return () => {
      cancelled = true;
    };
  }, [open, loadHistory]);

  // What the selected commit changed, against its first parent.
  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;

    setDetail(null);
    diffFor(selected).then((ops) => {
      if (!cancelled) setDetail(ops);
    });

    return () => {
      cancelled = true;
    };
  }, [open, selected, diffFor]);

  const handleRestore = useCallback(async () => {
    if (!selected) return;
    setRestoring(true);
    setError(null);
    try {
      const doc = await restore(selected);
      onRestore(doc);
      onClose();
    } catch (err) {
      setError(err.message || t("historyDialog.restoreError"));
    } finally {
      setRestoring(false);
    }
  }, [selected, restore, onRestore, onClose, t]);

  const isCurrent = commits && selected === commits[0]?.oid;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HistoryIcon className="size-4" />
            {t("historyDialog.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 overflow-y-auto border-t border-border pt-4">
          {error && (
            <Alert variant="destructive" className="relative pr-9">
              <AlertDescription>{error}</AlertDescription>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label={t("historyDialog.dismiss")}
                className="absolute top-3 right-3 cursor-pointer rounded-sm border-0 bg-transparent p-0.5 text-current opacity-70 transition-opacity hover:opacity-100"
              >
                <XIcon className="size-3.5" />
              </button>
            </Alert>
          )}
          {pending > 0 && (
            <Alert className="border-primary/40 bg-primary/10 text-primary">
              <AlertDescription className="text-primary">
                {t("historyDialog.pendingChanges", { count: pending })}
              </AlertDescription>
            </Alert>
          )}

          {commits === null ? (
            <HistorySkeleton />
          ) : commits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("historyDialog.noVersions")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
              {/* The timeline. */}
              <div className="flex max-h-[420px] flex-col gap-0.5 overflow-y-auto md:col-span-5">
                {commits.map((commit, i) => (
                  <button
                    key={commit.oid}
                    type="button"
                    onClick={() => setSelected(commit.oid)}
                    className={cn(
                      "cursor-pointer rounded-md border-0 px-2 py-1.5 text-left transition-colors",
                      commit.oid === selected
                        ? "bg-accent text-accent-foreground"
                        : "bg-transparent hover:bg-accent/50",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {commit.isMerge && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <GitMergeIcon className="size-3.5 shrink-0 text-secondary-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("historyDialog.mergeTooltip")}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <p
                        className={cn(
                          "truncate text-sm",
                          i === 0 ? "font-semibold" : "font-normal",
                        )}
                      >
                        {commit.summary}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {i === 0 ? t("historyDialog.currentPrefix") : ""}
                      {timeAgo(commit.timestamp)} · {commit.author}
                    </p>
                  </button>
                ))}
              </div>

              {/* What that version changed. */}
              <div className="min-h-[200px] rounded-md border border-border p-3 md:col-span-7">
                {detail === null ? (
                  <HistorySkeleton count={3} />
                ) : detail.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("historyDialog.origin")}
                  </p>
                ) : (
                  <>
                    <p className="text-sm font-medium">
                      {t("historyDialog.whatChanged")}
                    </p>
                    <ChangeChips ops={detail} />
                    <hr className="my-3 border-border" />
                    <ul className="m-0 flex max-h-[260px] flex-col gap-1 overflow-y-auto pl-4">
                      {detail.map((op, i) => (
                        <li
                          key={i}
                          className="list-disc text-sm text-muted-foreground"
                        >
                          {/* describeOp renders "- edit text block <id>"; drop the
                              leading marker, the list already provides one. */}
                          {describeOp(op).replace(/^- /, "")}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("historyDialog.close")}
          </Button>
          <Button
            disabled={
              !selected || restoring || isCurrent || commits?.length === 0
            }
            onClick={handleRestore}
          >
            <RotateCcwIcon data-icon="inline-start" />
            {isCurrent
              ? t("historyDialog.restoreCurrent")
              : t("historyDialog.restore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
