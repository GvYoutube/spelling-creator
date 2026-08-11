// Variations: separate copies of a lesson its author can change freely, while the
// lesson everybody else reads stays exactly as it is.
//
// Underneath, each one is a branch of the lesson's git repository, and switching
// between them is a checkout. None of that vocabulary appears here, and none of
// it should: an author is not doing version control, they are trying something
// and keeping the original safe while they do. So the words are "variation",
// "the main lesson", "bring it in" — and the only number on screen is how much
// work is sitting on a variation, which is the one thing they actually want to
// know before opening it.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  GitMergeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.jsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { ListRowsSkeleton } from "./Skeletons.jsx";
import { Spinner } from "./ui/spinner.jsx";
import { cn } from "../lib/utils.js";
import { DEFAULT_BRANCH, branchLabel } from "@spelling-creator/core/git/refs";

/**
 * @param {object}   props.git       The useLessonGit controller.
 * @param {Function} props.onSwitch  Called with the document at the variation
 *                                   switched to; the editor adopts it.
 * @param {Function} props.onBringIn Called with a variation's name to merge it
 *                                   into the main lesson. The editor owns that
 *                                   flow because it may need the merge dialog.
 */
export default function VariationsDialog({
  open,
  onClose,
  git,
  onSwitch,
  onBringIn,
}) {
  const { t } = useTranslation("editorTools");
  const { branches, branch, refreshBranches, ready } = git;

  // Which row, if any, is being named — "new" for the one being created, or the
  // branch name for one being renamed. One at a time, because two open name
  // fields in a six-row list is a puzzle rather than a feature.
  const [naming, setNaming] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(null); // the branch name being worked on
  const [error, setError] = useState(null);

  // Re-read on open: a save may have brought a variation down from another
  // device since this was last looked at.
  useEffect(() => {
    if (!open) return;
    setNaming(null);
    setName("");
    setError(null);
    refreshBranches();
  }, [open, refreshBranches]);

  const attempt = useCallback(async (key, work) => {
    setBusy(key);
    setError(null);
    try {
      return await work();
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const submitName = useCallback(async () => {
    const label = name.trim();
    if (!label) return;

    // Creating a variation doesn't change the document — the new branch starts at
    // the commit we are already on — so there is nothing for the editor to adopt
    // here. Only switching hands a document back.
    const done = await attempt(naming, async () =>
      naming === "new"
        ? git.createVariation(label)
        : git.renameVariation(naming, label),
    );
    if (done === null) return;

    setNaming(null);
    setName("");
  }, [attempt, git, name, naming]);

  const handleSwitch = useCallback(
    async (to) => {
      if (to === branch) return;
      const doc = await attempt(to, () => git.switchBranch(to));
      if (doc) {
        onSwitch(doc);
        onClose();
      }
    },
    [attempt, branch, git, onClose, onSwitch],
  );

  const handleDelete = useCallback(
    async (target) => {
      // Switching away first is what makes deleting the one you're looking at
      // possible at all, and it lands you somewhere sensible either way.
      if (target === branch) {
        const doc = await attempt(target, () =>
          git.switchBranch(DEFAULT_BRANCH),
        );
        if (!doc) return;
        onSwitch(doc);
      }
      await attempt(target, () => git.deleteVariation(target));
    },
    [attempt, branch, git, onSwitch],
  );

  const startNaming = useCallback((key, initial) => {
    setNaming(key);
    setName(initial);
    setError(null);
  }, []);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("variations.title")}</DialogTitle>
          <DialogDescription>{t("variations.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 overflow-y-auto border-t border-border pt-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!ready ? (
            <ListRowsSkeleton count={2} />
          ) : (
            branches.map((item) =>
              naming === item.name ? (
                <NameField
                  key={item.name}
                  value={name}
                  onChange={setName}
                  onSubmit={submitName}
                  onCancel={() => setNaming(null)}
                  busy={busy === item.name}
                  submitLabel={t("variations.saveName")}
                />
              ) : (
                <Row
                  key={item.name}
                  item={item}
                  current={item.name === branch}
                  busy={busy === item.name}
                  onSwitch={() => handleSwitch(item.name)}
                  onRename={() =>
                    startNaming(item.name, branchLabel(item.name))
                  }
                  onBringIn={() => {
                    onBringIn(item.name);
                    onClose();
                  }}
                  onDelete={() => handleDelete(item.name)}
                />
              ),
            )
          )}

          {naming === "new" && (
            <NameField
              autoFocus
              value={name}
              onChange={setName}
              onSubmit={submitName}
              onCancel={() => setNaming(null)}
              busy={busy === "new"}
              placeholder={t("variations.namePlaceholder")}
              submitLabel={t("variations.create")}
            />
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {t("variations.privacy")}
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("variations.close")}
          </Button>
          <Button
            disabled={!ready || naming === "new"}
            onClick={() => startNaming("new", "")}
          >
            <PlusIcon data-icon="inline-start" />
            {t("variations.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One variation: what it is called, how much is on it, and what can be done. */
function Row({ item, current, busy, onSwitch, onRename, onBringIn, onDelete }) {
  const { t } = useTranslation("editorTools");

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2",
        current ? "border-primary/40 bg-primary/5" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={onSwitch}
        disabled={busy}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left disabled:cursor-default"
      >
        {busy ? (
          <Spinner className="size-4 shrink-0" />
        ) : (
          <CheckIcon
            className={cn("size-4 shrink-0", current ? "" : "opacity-0")}
          />
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {item.isDefault
              ? t("variations.mainLesson")
              : branchLabel(item.name)}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {current
              ? t("variations.editingNow")
              : item.isDefault
                ? t("variations.mainLessonHint")
                : t("variations.changesAhead", { count: item.ahead })}
          </span>
        </span>
      </button>

      {!item.isDefault && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={t("variations.moreActions", {
                name: branchLabel(item.name),
              })}
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onBringIn}>
              <GitMergeIcon />
              {t("variations.bringIn")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRename}>
              <PencilIcon />
              {t("variations.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2Icon />
              {t("variations.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Naming a variation, whether it is being created or renamed. */
function NameField({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  placeholder,
  submitLabel,
  autoFocus,
}) {
  const { t } = useTranslation("editorTools");

  return (
    <form
      className="flex items-center gap-2 rounded-md border border-primary/40 px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Input
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        maxLength={40}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && onCancel()}
        className="h-8"
      />
      <Button type="submit" size="sm" disabled={busy || !value.trim()}>
        {busy ? <Spinner data-icon="inline-start" /> : null}
        {submitLabel}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        {t("variations.cancel")}
      </Button>
    </form>
  );
}
