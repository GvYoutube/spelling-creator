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
//   Theirs      take the other side's
//   Keep both   keep ours AND add theirs as a second block (nothing is lost)
//
// The same dialog settles both directions: pulling an original's changes into a
// fork, and merging a pull request into the lesson it proposes to. Only the
// framing differs — merging a proposal changes the published lesson for
// everyone, so it says so.
//
// See lib/git/merge.js for the merge itself; this component only chooses.

import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
import { questionMeta } from "@spelling-creator/core/questions";

/** A contested value, rendered readably whatever shape it has. */
function ValueText({ value }) {
  const { t } = useTranslation("editorTools");
  if (value === null || value === undefined || value === "") {
    return (
      <p className="text-sm text-muted-foreground italic">
        {t("mergeDialog.emptyValue")}
      </p>
    );
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
function blockLabel(block, t) {
  if (!block) return t("mergeDialog.blockLabel.default");
  if (block.type === "question") {
    return t("mergeDialog.blockLabel.question", {
      type: questionMeta(block.questionType).short,
    });
  }
  if (block.type === "spelling") return t("mergeDialog.blockLabel.spelling");
  if (block.type === "image") return t("mergeDialog.blockLabel.image");
  return t("mergeDialog.blockLabel.text");
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
  const { t } = useTranslation("editorTools");
  const block = conflict.ours || conflict.theirs;
  const deleted = conflict.kind === "delete/edit";

  return (
    <div className="rounded-md border border-border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{blockLabel(block, t)}</span>
          <Badge
            variant="outline"
            className={cn(deleted && "border-focus/40 bg-focus/10 text-focus")}
          >
            {deleted
              ? conflict.deletedBy === "theirs"
                ? t("mergeDialog.deletedIn", { name: theirName })
                : t("mergeDialog.youDeletedThis")
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
            {deleted
              ? t("mergeDialog.choice.keepIt")
              : t("mergeDialog.choice.mine")}
          </ToggleGroupItem>
          <ToggleGroupItem value="theirs">
            {deleted
              ? t("mergeDialog.choice.deleteIt")
              : t("mergeDialog.choice.theirs")}
          </ToggleGroupItem>
          {!deleted && (
            <ToggleGroupItem value="both">
              {t("mergeDialog.choice.keepBoth")}
            </ToggleGroupItem>
          )}
        </ToggleGroup>
      </div>

      {deleted ? (
        <p className="text-sm text-muted-foreground">
          {conflict.deletedBy === "theirs"
            ? t("mergeDialog.deletedByThem", { name: theirName })
            : t("mergeDialog.deletedByYou", { name: theirName })}
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
                  label={t("mergeDialog.choice.mine")}
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
 * @param {string}   props.theirName What to call the other side — the original's
 *                                   title when pulling, the proposal's when reviewing one.
 * @param {string}   [props.proposerName] Who opened the proposal, when reviewing one.
 * @param {"pull"|"pull-request"|"publish"|"variation"} props.intent  What happens
 *                                   once it's settled.
 * @param {Function} props.onConfirm Called with the { blockId: choice } map.
 */
export default function MergeDialog({
  open,
  onClose,
  prepared,
  theirName,
  proposerName,
  intent = "pull",
  onConfirm,
  busy,
}) {
  const { t } = useTranslation("editorTools");
  // Default every conflict to keeping our own work — the safe assumption is that
  // the user's own edits stand unless they say otherwise.
  const [choices, setChoices] = useState({});

  if (!prepared) return null;
  const { conflicts, auto } = prepared;

  const effectiveTheirName = theirName || t("mergeDialog.defaultTheirName");

  // Merging a proposal changes the published lesson itself, for everyone reading
  // it — so say that plainly rather than letting "Merge" imply it only touches
  // the copy in front of us.
  const reviewing = intent === "pull-request";
  // Folding one of the author's own variations into their lesson. Nothing arrives
  // from anybody else, so the framing is "bring this in" rather than "merge
  // theirs with ours".
  const variation = intent === "variation";
  const confirmLabel = busy
    ? reviewing
      ? t("mergeDialog.confirm.landing")
      : t("mergeDialog.confirm.merging")
    : reviewing
      ? t("mergeDialog.confirm.mergeProposal")
      : variation
        ? t("mergeDialog.confirm.mergeVariation")
        : t("mergeDialog.confirm.merge");

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
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMergeIcon className="size-4" />
            <span>
              {reviewing
                ? t("mergeDialog.title.pullRequest", {
                    name: effectiveTheirName,
                  })
                : variation
                  ? t("mergeDialog.title.variation", {
                      name: effectiveTheirName,
                    })
                  : t("mergeDialog.title.pull", { name: effectiveTheirName })}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto border-t border-border pt-4">
          {reviewing && (
            <Alert className="border-focus/40 bg-focus/10 text-focus">
              <TriangleAlertIcon />
              <AlertDescription className="text-focus">
                <Trans
                  i18nKey="mergeDialog.reviewingNotice"
                  ns="editorTools"
                  values={{
                    name: proposerName || t("mergeDialog.someone"),
                  }}
                  components={{ strong: <strong className="font-medium" /> }}
                />
              </AlertDescription>
            </Alert>
          )}
          {autoCount > 0 && (
            <Alert className="border-success/40 bg-success/10 text-success">
              <CircleCheckIcon />
              <AlertDescription className="text-success">
                <p className="mb-1">{t("mergeDialog.auto.heading")}</p>
                <ul className="ml-4 list-disc">
                  {auto.added.length > 0 && (
                    <li>
                      {t("mergeDialog.auto.newBlocks", {
                        count: auto.added.length,
                        name: effectiveTheirName,
                      })}
                    </li>
                  )}
                  {auto.tookTheirs.length > 0 && (
                    <li>
                      {t("mergeDialog.auto.theirEdits", {
                        count: auto.tookTheirs.length,
                      })}
                    </li>
                  )}
                  {auto.merged.length > 0 && (
                    <li>
                      <Trans
                        i18nKey="mergeDialog.auto.merged"
                        ns="editorTools"
                        count={auto.merged.length}
                        components={{
                          strong: <strong className="font-medium" />,
                        }}
                      />
                    </li>
                  )}
                  {auto.removed.length > 0 && (
                    <li>
                      {t("mergeDialog.auto.removed", {
                        count: auto.removed.length,
                      })}
                    </li>
                  )}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {conflicts.length === 0 ? (
            <Alert>
              <InfoIcon />
              <AlertDescription>
                {t("mergeDialog.noConflicts")}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t("mergeDialog.conflictsIntro", { count: conflicts.length })}
              </p>
              <div className="flex flex-col gap-4">
                {conflicts.map((conflict) => (
                  <ConflictCard
                    key={conflict.blockId}
                    conflict={conflict}
                    choice={choiceFor(conflict.blockId)}
                    onChoose={(value) => choose(conflict.blockId, value)}
                    theirName={effectiveTheirName}
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
            {t("mergeDialog.cancel")}
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
