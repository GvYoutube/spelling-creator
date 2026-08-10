// A lesson's own page (/hub/:id), and the shell its tabs render into.
//
// This replaces the single scrolling LessonPage, and the reason is that a lesson
// is a git repository — it has forks, a commit history, and proposals opened
// against it from other people's clones. All of that used to be stacked under
// the document or hidden in a dialog, because one centred column was the only
// place to put it. Here each of those is a tab with its own URL, the way a repo
// host does it: shareable, back-button-correct, and server-renderable.
//
// This component owns everything the tabs share — the fetch, the identity
// header, and every action that acts on the lesson as a whole (export, fork,
// edit, delete, and the moderator tools). The tabs own only their own body and
// read the lesson from `useLesson()`.
//
// Note what did *not* move here: merging a proposal. That is a real three-way
// merge against the lesson's git history, and the history lives in the editor's
// browser-side repository — so "Review & merge" still hands off to the editor.
// See LessonProposal.jsx.

import { hasApi } from "@spelling-creator/core/config";
import { useEffect, useRef, useState } from "react";
import {
  Link as RouterLink,
  Outlet,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  BanIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  EyeOffIcon,
  FileDownIcon,
  GitForkIcon,
  PencilIcon,
  PlayIcon,
  PrinterIcon,
  ShieldIcon,
  Trash2Icon,
  WifiOffIcon,
} from "lucide-react";
import PageBar from "../../components/layout/PageBar.jsx";
import PageBody from "../../components/layout/PageBody.jsx";
import LessonTabs from "./LessonTabs.jsx";
import { Button } from "../../components/ui/button.jsx";
import { Badge } from "../../components/ui/badge.jsx";
import { Alert, AlertDescription } from "../../components/ui/alert.jsx";
import { Field, FieldLabel } from "../../components/ui/field.jsx";
import { Input } from "../../components/ui/input.jsx";
import { Spinner } from "../../components/ui/spinner.jsx";
import { StarRating } from "../../components/ui/star-rating.jsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../../components/ui/dialog.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../components/ui/dropdown-menu.jsx";
import { LessonContentSkeleton } from "../../components/Skeletons.jsx";
import { lessonPlainText } from "../../components/LessonView.jsx";
import {
  fetchLesson,
  deleteLesson,
  EDIT_REQUEST_KEY,
  FORK_REQUEST_KEY,
} from "@spelling-creator/core/lessons";
import { isInteractivePlayable } from "@spelling-creator/core/interactive";
import {
  setShadowban,
  banName,
  banIp,
  requestLessonDeletion,
  deleteLessonAsAdmin,
} from "@spelling-creator/core/moderation";
import { useAuth } from "../../lib/auth.jsx";
import {
  DocumentMeta,
  JsonLd,
  buildLessonCourseSchema,
  htmlToDescription,
} from "../../lib/seo.jsx";
import { useServerData, useSiteOrigin } from "../../lib/ssr.jsx";
// The docx/PDF pipeline loads on demand — see lib/exports/engine.js. This is a
// public, server-rendered route, so it must not preload the Word toolchain.
import { loadExportEngine } from "../../lib/exports/load.js";

/**
 * The lesson and its shared actions, for the tab currently rendered into this
 * layout's <Outlet/>. Every file under pages/lesson/ reads its data through
 * this rather than fetching again.
 */
export function useLesson() {
  return useOutletContext();
}

export function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function LessonLayout() {
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
  const origin = useSiteOrigin();

  // Present only on the very first render of a server-rendered page load: the
  // Worker already fetched this lesson anonymously, so hydration starts with the
  // document rather than a skeleton, and the effect below skips the round trip
  // it would otherwise repeat. undefined on every client-side navigation.
  const serverLesson = useServerData("lesson");

  const [lesson, setLesson] = useState(serverLesson ?? null);
  const [loading, setLoading] = useState(!serverLesson);
  const [error, setError] = useState("");

  // Which export is in flight ('docx' | 'pdf' | null).
  const [busy, setBusy] = useState(null);

  // Bumped after a completed interactive run-through, which re-fetches the
  // reader's own saved answers on the overview tab.
  const [answersSaved, setAnswersSaved] = useState(0);

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

  // Which lesson the server-rendered copy is of, or null when there isn't one.
  // Keyed by id rather than a spend-once flag: this effect re-runs for reasons
  // that have nothing to do with the data going stale (i18next handing back a
  // new `t`, the session resolving), and a one-shot flag would be burnt by the
  // first of those and re-fetch a lesson we already have.
  const serverLessonId = useRef(serverLesson ? id : null);

  useEffect(() => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    // Wait for the session to resolve before fetching: a private draft needs
    // the access token to load for its owner, and firing off token-less first
    // would flash a spurious "not found" for them until this effect re-runs.
    if (authLoading) return;

    // The Worker renders anonymously, so what it sent is the public view of the
    // lesson — exactly what a signed-out visitor should see, and no reason to
    // fetch it a second time. A signed-in one still needs the authenticated
    // view (their own unpublished draft, the moderator fields), so they fall
    // through and re-fetch quietly underneath what's already on screen rather
    // than dropping back to a skeleton.
    const hadServerLesson = serverLessonId.current === id;
    if (hadServerLesson && !accessToken) return;
    // Past this point we're fetching, so the server's copy stops counting.
    serverLessonId.current = null;

    let cancelled = false;
    if (!hadServerLesson) {
      setLoading(true);
      setError("");
      setLesson(null);
    }
    (async () => {
      try {
        const full = await fetchLesson(id, accessToken);
        if (cancelled) return;
        setLesson(full);
      } catch (err) {
        if (cancelled) return;
        // A failed *quiet* re-fetch must not take the page down with it: the
        // server-rendered lesson on screen is still correct public content, and
        // `error` would replace it with an alert. All that's lost is the
        // signed-in view of it, which is worth strictly less than the content.
        if (hadServerLesson) console.error("Lesson re-fetch failed", err);
        else setError(err.message || t("lessonPage.couldNotOpen"));
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
        const { exportDocx } = await loadExportEngine();
        await exportDocx(lesson.doc);
        toast(t("lessonPage.wordDownloaded"));
      } else {
        const { exportPdf } = await loadExportEngine();
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

  // Whether interactive mode has anything to walk through. Every lesson the hub
  // holds is compatible with it — the walkthrough is derived from the document
  // itself (see core/interactive.js) — so this is only false for the degenerate
  // case of a lesson whose sections are all empty.
  const playable = isInteractivePlayable(lesson?.doc);

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

  const metaTitle =
    lesson?.title ||
    (loading
      ? t("lessonPage.lessonFallback")
      : error
        ? t("lessonPage.lessonNotFound")
        : t("lessonPage.lessonFallback"));

  // schema.org Course structured data so Google can show this lesson as a rich
  // result. Only emitted once the lesson has loaded successfully — no markup for
  // the loading or error states. The canonical URL is the overview tab even when
  // a sub-tab is what's open: the tabs are views of one lesson, not separate
  // works, and pointing them all at /hub/:id is what keeps them from competing
  // with each other in search results.
  const courseSchema =
    lesson && !error
      ? buildLessonCourseSchema({
          lesson,
          description,
          url: `${origin}/hub/${id}`,
          origin,
        })
      : null;

  const outlet = {
    id,
    lesson,
    setLesson,
    loading,
    error,
    isAuthor,
    isModerator,
    playable,
    busy,
    handleExport,
    forkLesson,
    editLesson,
    handleRated,
    answersSaved,
    onAnswersSaved: () => setAnswersSaved((count) => count + 1),
    formatDate,
  };

  return (
    <>
      {/* Title + social/SEO tags. React hoists these into <head>, so the
          server-rendered HTML carries them and a crawler needs no JavaScript. */}
      <DocumentMeta
        type="article"
        title={metaTitle}
        description={description}
      />
      <JsonLd data={courseSchema} />

      <PageBar
        crumbs={[
          { label: t("lessonPage.lessonHub"), to: "/hub" },
          { label: lesson?.title || t("lessonPage.lessonFallback") },
        ]}
      >
        {lesson && (
          <>
            {/* The one action worth a filled button: this is a lesson, and the
                thing you do with a lesson is work through it. Everything else
                is in the overflow menu or the overview's side rail. */}
            {playable && (
              <Button size="sm" asChild>
                <RouterLink to="practice" className="no-underline">
                  <PlayIcon data-icon="inline-start" />
                  <span className="hidden sm:inline">
                    {t("lessonPage.startInteractive")}
                  </span>
                </RouterLink>
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("lessonPage.lessonActionsAriaLabel")}
                >
                  <EllipsisVerticalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => handleExport("pdf")}
                  disabled={Boolean(busy)}
                >
                  {busy === "pdf" ? <Spinner /> : <PrinterIcon />}
                  {t("lessonPage.printPdf")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => handleExport("docx")}
                  disabled={Boolean(busy)}
                >
                  {busy === "docx" ? <Spinner /> : <FileDownIcon />}
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
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("lessonPage.moderationActionsAriaLabel")}
                  >
                    <ShieldIcon />
                  </Button>
                </DropdownMenuTrigger>
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
      </PageBar>

      {!hasApi() && (
        <PageBody>
          <Alert className="border-primary/40 bg-primary/10 text-primary">
            <AlertDescription className="text-primary">
              {t("lessonPage.hubDisabled")}
            </AlertDescription>
          </Alert>
        </PageBody>
      )}

      {hasApi() && loading && (
        <PageBody>
          <LessonContentSkeleton />
        </PageBody>
      )}

      {hasApi() && !loading && error && (
        <PageBody>
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
        </PageBody>
      )}

      {hasApi() && !loading && !error && lesson && (
        <>
          {/* The identity block: what this lesson is and who made it. It stays
              put across every tab, which is what makes the tabs read as views
              of one thing rather than as separate pages. The tab bar sits
              directly under it, so it drops the column's bottom padding. */}
          <PageBody className="pb-0">
            <div className="flex items-center gap-2">
              <h2 className="text-3xl font-semibold">
                {lesson.title || t("lessonPage.untitledLesson")}
              </h2>
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
            <p className="mt-1 text-sm text-muted-foreground">
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
              {lesson.createdAt ? ` · ${formatDate(lesson.createdAt)}` : ""}
            </p>
            {/* Average star rating, once the lesson has any ratings. Ratings are
                left from the discussion tab; this updates live via onRated. */}
            {lesson.ratingCount > 0 && (
              <div className="mt-1.5 flex items-center gap-1.5">
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
          </PageBody>

          <LessonTabs lesson={lesson} playable={playable} />

          <Outlet context={outlet} />
        </>
      )}

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
    </>
  );
}
