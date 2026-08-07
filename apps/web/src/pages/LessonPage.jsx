// A single lesson's own page, reachable at /hub/:id. This replaces the old hub
// preview dialog: opening a lesson now navigates here instead of popping a
// modal, so each lesson has a shareable URL. It fetches the full lesson by id,
// renders its document with the same docx→HTML preview pipeline the editor and
// export use, and shows the comments below. Authors get Edit/Delete here too.

import { hasApi } from "@spelling-creator/core/config";
import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  BanIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  EyeOffIcon,
  FileDownIcon,
  GitForkIcon,
  PencilIcon,
  PrinterIcon,
  ShieldIcon,
  Trash2Icon,
  WifiOffIcon,
} from "lucide-react";
import AppHeader from "../components/AppHeader.jsx";
import NavActions from "../components/NavActions.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Alert, AlertDescription } from "../components/ui/alert.jsx";
import { Field, FieldLabel } from "../components/ui/field.jsx";
import { Input } from "../components/ui/input.jsx";
import { Spinner } from "../components/ui/spinner.jsx";
import { StarRating } from "../components/ui/star-rating.jsx";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "../components/ui/tooltip.jsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu.jsx";
import CommentsSection from "../components/CommentsSection.jsx";
import LessonSummary from "../components/LessonSummary.jsx";
import { LessonContentSkeleton } from "../components/Skeletons.jsx";
import LessonView, { lessonPlainText } from "../components/LessonView.jsx";
import {
  fetchLesson,
  deleteLesson,
  EDIT_REQUEST_KEY,
  FORK_REQUEST_KEY,
} from "@spelling-creator/core/lessons";
import {
  setShadowban,
  banName,
  banIp,
  requestLessonDeletion,
  deleteLessonAsAdmin,
} from "@spelling-creator/core/moderation";
import { useAuth } from "../lib/auth.jsx";
import {
  useDocumentMeta,
  useJsonLd,
  buildLessonCourseSchema,
  htmlToDescription,
} from "../lib/seo.js";
import { exportDocx } from "@spelling-creator/core/browser/docxExport";
import { exportPdf } from "@spelling-creator/core/browser/pdfExport";

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function LessonPage() {
  const { t } = useTranslation("lesson");
  const { id } = useParams();
  const {
    user,
    accessToken,
    loading: authLoading,
    isModerator,
    isAdmin,
  } = useAuth();
  const navigate = useNavigate();

  const [lesson, setLesson] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Which export is in flight ('docx' | 'pdf' | null).
  const [busy, setBusy] = useState(null);

  // Delete-confirmation dialog. The user must retype the lesson's title to
  // confirm, guarding against an accidental, irreversible delete. `deleteMode`
  // is "author" for the author's own delete or "admin" for an admin full-delete
  // of someone else's lesson — same dialog, different endpoint on confirm.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState("author");
  const [deleteText, setDeleteText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [shadowBusy, setShadowBusy] = useState(false);
  // Deletion-request dialog (a moderator asking an admin to delete this lesson).
  const [reqOpen, setReqOpen] = useState(false);
  const [reqReason, setReqReason] = useState("");
  const [reqBusy, setReqBusy] = useState(false);
  const [reqError, setReqError] = useState("");
  // IP-ban confirm dialog (admin).
  const [ipBanOpen, setIpBanOpen] = useState(false);
  const [ipBanBusy, setIpBanBusy] = useState(false);
  const [ipBanError, setIpBanError] = useState("");

  useEffect(() => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    // Wait for the session to resolve before fetching: a private draft needs
    // the access token to load for its owner, and firing off token-less first
    // would flash a spurious "not found" for them until this effect re-runs.
    if (authLoading) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setLesson(null);
    (async () => {
      try {
        const full = await fetchLesson(id, accessToken);
        if (cancelled) return;
        // Render happens directly from the doc via <LessonView>; images
        // lazy-load in the browser, so there's no up-front render step to wait
        // on here — the page shows as soon as the lesson JSON arrives.
        setLesson(full);
      } catch (err) {
        if (!cancelled) setError(err.message || t("lessonPage.couldNotOpen"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, accessToken, authLoading, t]);

  // Send the user to the editor to edit their own lesson. The editor fetches the
  // full lesson and warns before replacing any in-progress work, so we only hand
  // it which lesson to load (via sessionStorage, consumed once on the editor's
  // mount).
  const editLesson = () => {
    try {
      sessionStorage.setItem(EDIT_REQUEST_KEY, id);
    } catch {
      /* ignore — navigation below still works, the editor just won't preload */
    }
    navigate("/editor");
  };

  // Fork this lesson: hand the editor the lesson id (via sessionStorage, consumed
  // once on the editor's mount) and head there. The editor loads the document as
  // a fresh, unattached draft, so anyone can copy a lesson and publish their own
  // version — they're never editing the original, so no special permission is
  // needed.
  const forkLesson = () => {
    try {
      sessionStorage.setItem(FORK_REQUEST_KEY, id);
    } catch {
      /* ignore — the editor just won't preload if storage is unavailable */
    }
    navigate("/editor");
  };

  // A rating was left with a comment (from CommentsSection): update the lesson's
  // displayed average in place so the stars refresh without re-fetching.
  const handleRated = (stats) => {
    setLesson((prev) =>
      prev
        ? { ...prev, avgRating: stats.average, ratingCount: stats.count }
        : prev,
    );
  };

  // Export the lesson document — same pipeline the editor uses. 'docx' downloads
  // a Word file; 'pdf' opens the print dialog to save as PDF.
  const handleExport = async (kind) => {
    if (!lesson) return;
    setBusy(kind);
    try {
      if (kind === "docx") {
        await exportDocx(lesson.doc);
        toast(t("lessonPage.wordDownloaded"));
      } else {
        await exportPdf(lesson.doc);
        toast(t("lessonPage.pdfGenerated"));
      }
    } catch (err) {
      toast(t("lessonPage.exportFailed", { error: err.message || err }));
    } finally {
      setBusy(null);
    }
  };

  // The title the user must type to confirm. Mirrors the fallback the hub and
  // backend use for an untitled lesson.
  const deleteTarget = lesson
    ? lesson.title || t("lessonPage.untitledLesson")
    : "";
  const deleteConfirmed = deleteText.trim() === deleteTarget;

  const closeDelete = () => {
    if (deleteBusy) return; // don't abandon an in-flight request
    setDeleteOpen(false);
  };

  const confirmDelete = async () => {
    if (!deleteConfirmed) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      // An author deletes their own lesson; an admin can fully delete anyone's.
      if (deleteMode === "admin") {
        await deleteLessonAsAdmin(id, accessToken);
      } else {
        await deleteLesson(id, accessToken);
      }
      // Hand the hub a one-shot toast so the user gets feedback after we leave.
      navigate("/hub", { state: { deletedTitle: deleteTarget } });
    } catch (err) {
      setDeleteError(err.message || t("lessonPage.couldNotDelete"));
      setDeleteBusy(false);
    }
  };

  const isAuthor =
    Boolean(user) && lesson?.authorId && lesson.authorId === user.id;

  // Open the type-the-title delete dialog in author or admin mode.
  const openDelete = (mode) => {
    setDeleteMode(mode);
    setDeleteText("");
    setDeleteError("");
    setDeleteOpen(true);
  };

  // Moderator: hide/show this lesson on the public hub. Updates local state so
  // the badge and menu label flip immediately.
  const toggleShadowban = async () => {
    if (!lesson) return;
    setShadowBusy(true);
    try {
      const next = !lesson.shadowbanned;
      await setShadowban(id, next, accessToken);
      setLesson((prev) => (prev ? { ...prev, shadowbanned: next } : prev));
      toast(next ? t("lessonPage.shadowbanned") : t("lessonPage.restored"));
    } catch (err) {
      toast(err.message || t("lessonPage.couldNotUpdate"));
    } finally {
      setShadowBusy(false);
    }
  };

  // Moderator: ban the lesson author by display name.
  const banAuthorName = async () => {
    const name = lesson?.author || "";
    if (!name) {
      toast(t("lessonPage.noAuthorNameToBan"));
      return;
    }
    try {
      await banName(name, accessToken);
      toast(t("lessonPage.bannedName", { name }));
    } catch (err) {
      toast(err.message || t("lessonPage.couldNotBanAuthor"));
    }
  };

  // Moderator: file a request for an admin to fully delete this lesson.
  const submitDeleteRequest = async () => {
    setReqBusy(true);
    setReqError("");
    try {
      await requestLessonDeletion(id, reqReason.trim(), accessToken);
      setReqOpen(false);
      setReqReason("");
      toast(t("lessonPage.deletionRequestSent"));
    } catch (err) {
      setReqError(err.message || t("lessonPage.couldNotSendRequest"));
    } finally {
      setReqBusy(false);
    }
  };

  // Admin: ban the address this lesson was published from.
  const confirmIpBan = async () => {
    setIpBanBusy(true);
    setIpBanError("");
    try {
      await banIp(lesson.authorIp, "", accessToken);
      setIpBanOpen(false);
      toast(t("lessonPage.bannedIp", { ip: lesson.authorIp }));
    } catch (err) {
      setIpBanError(err.message || t("lessonPage.couldNotBanIp"));
    } finally {
      setIpBanBusy(false);
    }
  };

  // Description shared by the social/SEO meta tags and the Course JSON-LD below,
  // drawn from the lesson's own text with a sensible fallback.
  const description =
    (lesson && htmlToDescription(lessonPlainText(lesson.doc))) ||
    (lesson
      ? lesson.author
        ? t("lessonPage.metaDescriptionByAuthor", { author: lesson.author })
        : t("lessonPage.metaDescription")
      : undefined);

  // Per-page title + social/SEO tags. Crawlers receive these in the Worker's
  // prerendered snapshot.
  useDocumentMeta({
    type: "article",
    title:
      lesson?.title ||
      (loading
        ? t("lessonPage.lessonFallback")
        : error
          ? t("lessonPage.lessonNotFound")
          : t("lessonPage.lessonFallback")),
    description,
  });

  // schema.org Course structured data so Google can show this lesson as a rich
  // result. Captured by the prerendered snapshot the same way the meta tags are.
  // Only emit it once the lesson has loaded successfully (no markup for the
  // loading/error states).
  useJsonLd(
    lesson && !error
      ? buildLessonCourseSchema({
          lesson,
          description,
          url: `${window.location.origin}/hub/${id}`,
          origin: window.location.origin,
        })
      : null,
  );

  return (
    <div className="min-h-dvh bg-background pb-16 text-foreground">
      <AppHeader
        title={lesson?.title || t("lessonPage.lessonFallback")}
        left={
          <Tooltip>
            <TooltipTrigger asChild>
              <RouterLink
                to="/hub"
                aria-label={t("lessonPage.lessonHubAriaLabel")}
                className="mr-1 inline-flex shrink-0 items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-sm font-medium text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10 md:px-4"
              >
                <ArrowLeftIcon data-icon="inline-start" />
                <span className="hidden md:inline">
                  {t("lessonPage.lessonHub")}
                </span>
              </RouterLink>
            </TooltipTrigger>
            <TooltipContent className="md:hidden">
              {t("lessonPage.lessonHub")}
            </TooltipContent>
          </Tooltip>
        }
      >
        {lesson && (
          <>
            {/* Desktop: the actions as their own buttons. */}
            <div className="hidden items-center gap-1 md:flex">
              <Button
                variant="ghost"
                onClick={() => handleExport("pdf")}
                disabled={Boolean(busy)}
                className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
              >
                {busy === "pdf" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <PrinterIcon data-icon="inline-start" />
                )}
                {t("lessonPage.printPdf")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => handleExport("docx")}
                disabled={Boolean(busy)}
                className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
              >
                {busy === "docx" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <FileDownIcon data-icon="inline-start" />
                )}
                {t("lessonPage.downloadWord")}
              </Button>
              <Button
                variant="ghost"
                onClick={forkLesson}
                disabled={Boolean(busy)}
                className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
              >
                <GitForkIcon data-icon="inline-start" />
                {t("lessonPage.fork")}
              </Button>
              {isAuthor && (
                <>
                  <Button
                    variant="ghost"
                    onClick={editLesson}
                    className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
                  >
                    <PencilIcon data-icon="inline-start" />
                    {t("lessonPage.edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => openDelete("author")}
                    className="text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
                  >
                    <Trash2Icon data-icon="inline-start" />
                    {t("lessonPage.delete")}
                  </Button>
                </>
              )}
            </div>

            {/* Mobile: the same actions collapsed into one overflow menu. */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("lessonPage.lessonActionsAriaLabel")}
                      className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10 md:hidden"
                    >
                      <EllipsisVerticalIcon />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>{t("lessonPage.lessonActions")}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => handleExport("pdf")}
                  disabled={Boolean(busy)}
                >
                  <PrinterIcon />
                  {t("lessonPage.printPdf")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => handleExport("docx")}
                  disabled={Boolean(busy)}
                >
                  <FileDownIcon />
                  {t("lessonPage.downloadWord")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={forkLesson} disabled={Boolean(busy)}>
                  <GitForkIcon />
                  {t("lessonPage.fork")}
                </DropdownMenuItem>
                {isAuthor && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={editLesson}>
                      <PencilIcon />
                      {t("lessonPage.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => openDelete("author")}
                    >
                      <Trash2Icon />
                      {t("lessonPage.delete")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Moderator/admin tools — one menu, shown to mods and admins. */}
            {isModerator && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t("lessonPage.moderationActionsAriaLabel")}
                        className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10"
                      >
                        <ShieldIcon />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("lessonPage.moderation")}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={toggleShadowban}
                    disabled={shadowBusy}
                  >
                    {lesson.shadowbanned ? <EyeIcon /> : <EyeOffIcon />}
                    {lesson.shadowbanned
                      ? t("lessonPage.unshadowbanLesson")
                      : t("lessonPage.shadowbanLesson")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={banAuthorName}>
                    <BanIcon />
                    {t("lessonPage.banAuthorByName")}
                  </DropdownMenuItem>
                  {/* Mods request deletion; admins delete outright. */}
                  {!isAdmin && (
                    <DropdownMenuItem
                      onClick={() => {
                        setReqReason("");
                        setReqError("");
                        setReqOpen(true);
                      }}
                    >
                      <Trash2Icon />
                      {t("lessonPage.requestDeletion")}
                    </DropdownMenuItem>
                  )}
                  {isAdmin && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => openDelete("admin")}
                    >
                      <Trash2Icon />
                      {t("lessonPage.deleteLessonFully")}
                    </DropdownMenuItem>
                  )}
                  {isAdmin && (
                    <DropdownMenuItem
                      onClick={() => {
                        setIpBanError("");
                        setIpBanOpen(true);
                      }}
                      disabled={!lesson.authorIp}
                    >
                      <WifiOffIcon />
                      {lesson.authorIp
                        ? t("lessonPage.banAuthorByIp")
                        : t("lessonPage.banByIpNoRecord")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
        <NavActions current="lesson" />
      </AppHeader>

      <div className="mx-auto max-w-3xl px-4 pt-6">
        {!hasApi() && (
          <Alert className="border-primary/40 bg-primary/10 text-primary">
            <AlertDescription className="text-primary">
              {t("lessonPage.hubDisabled")}
            </AlertDescription>
          </Alert>
        )}

        {hasApi() && loading && <LessonContentSkeleton />}

        {hasApi() && !loading && error && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-2">
              {error}
              <Button variant="ghost" size="sm" asChild>
                <RouterLink to="/hub" className="no-underline">
                  {t("lessonPage.backToHub")}
                </RouterLink>
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {hasApi() && !loading && !error && lesson && (
          <>
            <div className="mb-4 flex flex-col">
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-semibold">
                  {lesson.title || t("lessonPage.untitledLesson")}
                </h1>
                {/* Only the author and mods/admins can load a shadowbanned
                    lesson, so this badge is never seen by the public. */}
                {lesson.shadowbanned && (
                  <Badge
                    variant="outline"
                    className="border-focus/40 bg-focus/10 text-focus"
                  >
                    <EyeOffIcon />
                    {t("lessonPage.shadowbannedBadge")}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {lesson.authorId ? (
                  <RouterLink
                    to={`/users/${lesson.authorId}`}
                    className="text-inherit no-underline hover:underline"
                  >
                    {lesson.author || t("lessonPage.anonymous")}
                  </RouterLink>
                ) : (
                  lesson.author || t("lessonPage.anonymous")
                )}
                {typeof lesson.sectionCount === "number"
                  ? ` · ${t("lessonPage.sectionCount", { count: lesson.sectionCount })}`
                  : ""}
                {lesson.createdAt ? ` · ${formatDate(lesson.createdAt)}` : ""}
              </p>
              {/* Average star rating, once the lesson has any ratings. Ratings are
                  left from the comments box below; this updates live via onRated. */}
              {lesson.ratingCount > 0 && (
                <div className="mt-1 flex items-center gap-1.5">
                  <StarRating
                    value={lesson.avgRating || 0}
                    readOnly
                    size="sm"
                    aria-label={t("lessonPage.averageRatingAriaLabel")}
                  />
                  <p className="text-sm text-muted-foreground">
                    {(lesson.avgRating || 0).toFixed(1)} ·{" "}
                    {t("lessonPage.ratingCount", { count: lesson.ratingCount })}
                  </p>
                </div>
              )}
            </div>

            {/* On-device AI summary, above the lesson itself so a reader can
                decide whether to read on. Renders nothing unless the browser
                supports the Summarizer API. */}
            <LessonSummary doc={lesson.doc} />

            {/* LessonView renders the same white "printed page" the docx/PDF
                export produces (see the note on its own file) — the panel
                frame around it is themed so that white sheet reads as a
                deliberate page floating on the app's background, in both
                light and dark mode, rather than an unstyled leftover. */}
            <div className="overflow-hidden rounded-panel border border-border shadow-(--shadow-panel)">
              <LessonView doc={lesson.doc} />
            </div>

            <div className="mt-6">
              <CommentsSection lessonId={lesson.id} onRated={handleRated} />
            </div>
          </>
        )}
      </div>

      <Dialog open={deleteOpen} onOpenChange={(next) => !next && closeDelete()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("lessonPage.deleteDialog.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("lessonPage.deleteDialog.descriptionBefore")}{" "}
            <strong>{deleteTarget}</strong>{" "}
            {t("lessonPage.deleteDialog.descriptionAfter")}
          </p>
          <Field>
            <FieldLabel htmlFor="delete-lesson-name" className="sr-only">
              {t("lessonPage.deleteDialog.lessonNameLabel")}
            </FieldLabel>
            <Input
              id="delete-lesson-name"
              autoFocus
              placeholder={deleteTarget}
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && deleteConfirmed && !deleteBusy) {
                  confirmDelete();
                }
              }}
              disabled={deleteBusy}
            />
          </Field>
          {deleteError && (
            <Alert variant="destructive">
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeDelete}
              disabled={deleteBusy}
            >
              {t("lessonPage.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={!deleteConfirmed || deleteBusy}
            >
              {deleteBusy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Trash2Icon data-icon="inline-start" />
              )}
              {t("lessonPage.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Moderator → admin: request that this lesson be fully deleted. */}
      <Dialog
        open={reqOpen}
        onOpenChange={(next) => !next && !reqBusy && setReqOpen(false)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("lessonPage.requestDialog.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("lessonPage.requestDialog.descriptionBefore")}{" "}
            <strong>{deleteTarget}</strong>
            {t("lessonPage.requestDialog.descriptionAfter")}
          </p>
          <Field>
            <FieldLabel htmlFor="delete-request-reason" className="sr-only">
              {t("lessonPage.requestDialog.reasonLabel")}
            </FieldLabel>
            <Input
              id="delete-request-reason"
              autoFocus
              placeholder={t("lessonPage.requestDialog.reasonPlaceholder")}
              value={reqReason}
              onChange={(e) => setReqReason(e.target.value)}
              disabled={reqBusy}
              maxLength={1000}
            />
          </Field>
          {reqError && (
            <Alert variant="destructive">
              <AlertDescription>{reqError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReqOpen(false)}
              disabled={reqBusy}
            >
              {t("lessonPage.cancel")}
            </Button>
            <Button onClick={submitDeleteRequest} disabled={reqBusy}>
              {reqBusy && <Spinner data-icon="inline-start" />}
              {t("lessonPage.requestDialog.sendRequest")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin: ban the IP this lesson was published from. */}
      <Dialog
        open={ipBanOpen}
        onOpenChange={(next) => !next && !ipBanBusy && setIpBanOpen(false)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("lessonPage.ipBanDialog.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("lessonPage.ipBanDialog.descriptionPart1")}{" "}
            <strong>
              {lesson?.authorIp || t("lessonPage.ipBanDialog.thisAddress")}
            </strong>{" "}
            {t("lessonPage.ipBanDialog.descriptionPart2")}{" "}
            <strong>
              {lesson?.author || t("lessonPage.ipBanDialog.theAuthor")}
            </strong>{" "}
            {t("lessonPage.ipBanDialog.descriptionPart3")}
          </p>
          {ipBanError && (
            <Alert variant="destructive">
              <AlertDescription>{ipBanError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIpBanOpen(false)}
              disabled={ipBanBusy}
            >
              {t("lessonPage.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmIpBan}
              disabled={ipBanBusy || !lesson?.authorIp}
            >
              {ipBanBusy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <WifiOffIcon data-icon="inline-start" />
              )}
              {t("lessonPage.ipBanDialog.banIp")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
