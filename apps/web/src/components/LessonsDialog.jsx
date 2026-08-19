// The lessons this device is holding, and the way between them.
//
// The editor used to have exactly one working document, so "open a lesson" and
// "throw away what you were doing" were the same act — hence the old "Replace
// your current work?" warning. IndexedDB has no reason to hold one lesson rather
// than fifty (see core/browser/storage.js), so it holds as many as are made and
// this is the list of them: switch, copy, rename, delete, start another.
//
// Every row is a whole lesson — its document, its images and its git repository
// — so the only destructive action here is deleting one, and that asks twice,
// the same way VariationsDialog does. Everything else is reversible by clicking
// a different row.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  CloudIcon,
  CloudUploadIcon,
  CopyIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  MoreHorizontalIcon,
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
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { ListRowsSkeleton } from "./Skeletons.jsx";
import { cn } from "../lib/utils.js";
import { timeAgo } from "./HistoryDialog.jsx";

/**
 * @param {object}   props.lessons     The library, newest first — or null while
 *                                     it is being read (which draws a skeleton).
 * @param {string}   props.currentId   The lesson open in the editor.
 * @param {Function} props.onRefresh   Re-read the library.
 * @param {Function} props.onOpen      Switch the editor to a lesson.
 * @param {Function} props.onCreate    Start a new, empty lesson.
 * @param {Function} props.onDuplicate Copy a lesson into a new one.
 * @param {Function} props.onDelete    Remove a lesson from this device.
 * @param {Function} props.onRename    Retitle a lesson.
 */
export default function LessonsDialog({
  open,
  onClose,
  lessons,
  currentId,
  onRefresh,
  onOpen,
  onCreate,
  onDuplicate,
  onDelete,
  onRename,
}) {
  const { t } = useTranslation("editorTools");

  // The lesson being retitled, and the title being typed. One at a time — two
  // open name fields in a list is a puzzle rather than a feature.
  const [naming, setNaming] = useState(null);
  const [name, setName] = useState("");
  // The lesson awaiting a second press before it goes. Deleting one takes its
  // document, its local images and its whole version history with it, and there
  // is no undo for that here.
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(null);

  // Re-read on open: the list is a snapshot, and this one may have been left
  // open in another tab, or added to by a fork since it was last looked at.
  useEffect(() => {
    if (!open) return;
    setNaming(null);
    setName("");
    setConfirming(null);
    onRefresh();
  }, [open, onRefresh]);

  const run = useCallback(async (id, work) => {
    setBusy(id);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  }, []);

  const submitName = useCallback(async () => {
    const title = name.trim();
    const id = naming;
    setNaming(null);
    setName("");
    if (!id || !title) return;
    await run(id, () => onRename(id, title));
  }, [name, naming, onRename, run]);

  const handleOpen = useCallback(
    async (id) => {
      if (id === currentId) {
        onClose();
        return;
      }
      await run(id, () => onOpen(id));
      onClose();
    },
    [currentId, onClose, onOpen, run],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[85dvh] w-full flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("lessonsDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("lessonsDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 flex-1 overflow-y-auto px-1">
          {lessons === null ? (
            <ListRowsSkeleton count={3} />
          ) : (
            <ul className="flex list-none flex-col gap-2 p-0">
              {lessons.map((lesson) => {
                const isCurrent = lesson.id === currentId;
                const title = lesson.title || t("lessonsDialog.untitled");
                return (
                  <li
                    key={lesson.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md border p-2",
                      isCurrent
                        ? "border-primary/40 bg-primary/5"
                        : "border-border",
                    )}
                  >
                    {naming === lesson.id ? (
                      <Input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={submitName}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitName();
                          if (e.key === "Escape") setNaming(null);
                        }}
                        aria-label={t("lessonsDialog.titleLabel")}
                        className="h-9"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => handleOpen(lesson.id)}
                          disabled={busy !== null}
                          className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left"
                        >
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium">
                              {title}
                            </span>
                            {isCurrent && (
                              <CheckIcon className="size-4 shrink-0 text-primary" />
                            )}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span>
                              {t("lessonsDialog.stats", {
                                sections: t("lessonsDialog.sectionsCount", {
                                  count: lesson.sections || 0,
                                }),
                                blocks: t("lessonsDialog.blocksCount", {
                                  count: lesson.blocks || 0,
                                }),
                              })}
                            </span>
                            {lesson.updatedAt && (
                              <span>
                                {t("lessonsDialog.edited", {
                                  time: timeAgo(lesson.updatedAt),
                                })}
                              </span>
                            )}
                          </span>
                        </button>

                        {/* Where this lesson lives besides here. A lesson with
                            no badge exists on this device only — which is worth
                            knowing before clearing your browser data. */}
                        {lesson.lessonId && (
                          <Badge
                            variant="outline"
                            className="hidden shrink-0 gap-1 sm:inline-flex"
                          >
                            {lesson.published === false ? (
                              <CloudIcon />
                            ) : (
                              <CloudUploadIcon />
                            )}
                            {lesson.published === false
                              ? t("lessonsDialog.cloudDraft")
                              : t("lessonsDialog.published")}
                          </Badge>
                        )}

                        {confirming === lesson.id ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy !== null}
                              onClick={() =>
                                run(lesson.id, async () => {
                                  setConfirming(null);
                                  await onDelete(lesson.id);
                                })
                              }
                            >
                              {t("lessonsDialog.confirmDelete")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirming(null)}
                            >
                              {t("lessonsDialog.keepIt")}
                            </Button>
                          </div>
                        ) : (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                disabled={busy !== null}
                                aria-label={t("lessonsDialog.rowActions", {
                                  title,
                                })}
                              >
                                <MoreHorizontalIcon />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => {
                                  setName(lesson.title || "");
                                  setNaming(lesson.id);
                                }}
                              >
                                <PencilIcon />
                                {t("lessonsDialog.rename")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  run(lesson.id, () => onDuplicate(lesson.id))
                                }
                              >
                                <CopyIcon />
                                {t("lessonsDialog.duplicate")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setConfirming(lesson.id)}
                              >
                                <Trash2Icon />
                                {t("lessonsDialog.delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Deleting a lesson takes its history with it, and none of this is
            backed up anywhere unless the lesson has been saved to the cloud.
            Say so once, here, rather than in each row. */}
        <p className="text-xs text-muted-foreground">
          {t("lessonsDialog.storageNote")}
        </p>

        <DialogFooter className="sm:justify-between">
          <Button
            onClick={async () => {
              await onCreate();
              onClose();
            }}
            disabled={busy !== null}
          >
            <PlusIcon data-icon="inline-start" />
            {t("lessonsDialog.newLesson")}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {t("lessonsDialog.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
