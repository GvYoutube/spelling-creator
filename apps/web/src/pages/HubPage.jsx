// Lesson hub — a public, read-only gallery of lessons other users have
// published. Summaries come from the Worker (GET /lessons); clicking a card
// navigates to that lesson's own page (/hub/:id), where the full document is
// fetched and rendered. Each lesson therefore has a shareable URL.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import {
  CloudIcon,
  PencilIcon,
  RefreshCwIcon,
  RssIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import AppHeader from "../components/AppHeader.jsx";
import NavActions from "../components/NavActions.jsx";
import IconActionButton from "../components/IconActionButton.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Alert, AlertDescription } from "../components/ui/alert.jsx";
import { Field, FieldLabel } from "../components/ui/field.jsx";
import { Input } from "../components/ui/input.jsx";
import { Spinner } from "../components/ui/spinner.jsx";
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
  fetchPublishedLessons,
  fetchMyLessons,
  deleteLesson,
  lessonHubEnabled,
  lessonsFeedUrl,
  EDIT_REQUEST_KEY,
} from "../lib/lessons.js";
import { LessonGridSkeleton } from "../components/Skeletons.jsx";
import { buildLessonIndex, searchLessons } from "../lib/lessonSearch.js";
import { useAuth } from "../lib/auth.jsx";
import {
  useDocumentMeta,
  useJsonLd,
  buildLessonListSchema,
} from "../lib/seo.js";

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

// A published/draft lesson card: the whole thing links to the lesson, with
// the owner's edit/delete controls layered on top as siblings (not nested
// inside the link — an <a> can't contain interactive descendants).
function LessonCard({ lesson, draft, editable, onEdit, onDelete }) {
  const navigate = useNavigate();
  return (
    <div className="relative h-full rounded-md border border-border">
      {editable && (
        <div className="absolute top-1 right-1 z-10 flex gap-0.5">
          <IconActionButton
            tooltip={draft ? "Edit this draft" : "Edit this lesson"}
            aria-label={draft ? "edit draft" : "edit lesson"}
            onClick={(e) => onEdit(e, lesson)}
            className="bg-card hover:bg-accent"
          >
            <PencilIcon />
          </IconActionButton>
          <IconActionButton
            tooltip={draft ? "Delete this draft" : "Delete this lesson"}
            aria-label={draft ? "delete draft" : "delete lesson"}
            onClick={(e) => onDelete(e, lesson)}
            destructive
            className="bg-card hover:bg-destructive/10"
          >
            <Trash2Icon />
          </IconActionButton>
        </div>
      )}
      <RouterLink
        to={`/hub/${lesson.id}`}
        className="flex h-full flex-col rounded-md p-4 no-underline transition-colors hover:bg-accent"
      >
        {draft && (
          <Badge variant="outline" className="mb-2 w-fit gap-1">
            <CloudIcon />
            Draft
          </Badge>
        )}
        <h3 className="truncate pr-8 text-base font-semibold text-foreground">
          {lesson.title || "Untitled Lesson"}
        </h3>
        {!draft && (
          <p className="text-sm text-muted-foreground">
            {lesson.authorId ? (
              // The whole card is already a link, so the author can't be a
              // nested <a>. Use a clickable span that navigates to the
              // profile and stops the card's own navigation.
              <span
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  navigate(`/users/${lesson.authorId}`);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    navigate(`/users/${lesson.authorId}`);
                  }
                }}
                className="cursor-pointer hover:underline"
              >
                {lesson.author || "Anonymous"}
              </span>
            ) : (
              lesson.author || "Anonymous"
            )}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {typeof lesson.sectionCount === "number"
            ? `${lesson.sectionCount} section${lesson.sectionCount === 1 ? "" : "s"}`
            : ""}
          {lesson.createdAt ? ` · ${formatDate(lesson.createdAt)}` : ""}
        </p>
      </RouterLink>
    </div>
  );
}

export default function HubPage() {
  useDocumentMeta({
    title: "Lesson hub",
    description:
      "Browse and copy community-made spelling lessons, then print or export them.",
  });
  const { user, accessToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // The signed-in user's own drafts (lessons backed up to the cloud but not
  // published). They're excluded from the public listing above, so we fetch them
  // separately and show them in their own section. Failing to load them is
  // non-fatal — drafts are a convenience on top of browsing the public hub.
  const [drafts, setDrafts] = useState([]);

  // Client-side search. `query` is what the user typed; `debouncedQuery` lags it
  // by 200ms so we don't re-run the index on every keystroke. The Fuse index is
  // rebuilt only when the lesson list changes.
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const searchIndex = useMemo(() => buildLessonIndex(lessons), [lessons]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(id);
  }, [query]);

  // null when the box is empty -> show the full, newest-first listing.
  const searchResults = useMemo(
    () => searchLessons(searchIndex, debouncedQuery),
    [searchIndex, debouncedQuery],
  );
  const visibleLessons = searchResults ?? lessons;
  const searching = searchResults !== null;

  // schema.org Course-list carousel for the published lessons — the still-
  // supported Course rich result (the per-lesson "Course info" markup was
  // retired by Google in Sept 2025). Each entry embeds a full named Course, as
  // the carousel requires. We always describe the full published set (not the
  // transient search view), and the builder emits nothing below Google's three-
  // course minimum. Captured for crawlers via the Worker's prerendered snapshot.
  useJsonLd(buildLessonListSchema({ lessons, origin: window.location.origin }));

  // Delete-confirmation dialog. `deleting` holds the lesson summary being
  // deleted (null when closed); the user must retype its title to confirm, which
  // guards against an accidental, irreversible delete. `deleteText` is what they
  // typed, `deleteBusy` disables the action while the request is in flight.
  const [deleting, setDeleting] = useState(null);
  const [deleteText, setDeleteText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setLessons(await fetchPublishedLessons());
    } catch (err) {
      setError(err.message || "Could not load lessons.");
    } finally {
      setLoading(false);
    }
  };

  const loadDrafts = useCallback(async () => {
    if (!accessToken) {
      setDrafts([]);
      return;
    }
    try {
      const mine = await fetchMyLessons(accessToken);
      setDrafts(mine.filter((l) => l.published === false));
    } catch {
      setDrafts([]); // non-fatal — the public listing still works
    }
  }, [accessToken]);

  useEffect(() => {
    if (lessonHubEnabled) load();
    else setLoading(false);
  }, []);

  // Load (or clear) the user's drafts whenever their sign-in state changes.
  useEffect(() => {
    if (lessonHubEnabled) loadDrafts();
  }, [loadDrafts]);

  // The lesson page hands us a one-shot toast (e.g. after a delete) via router
  // state when it navigates back here. Show it once, then clear the state so it
  // doesn't reappear on refresh or back-navigation.
  useEffect(() => {
    const deletedTitle = location.state?.deletedTitle;
    if (deletedTitle) {
      toast(`Deleted “${deletedTitle}”.`);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, navigate]);

  // Send the user to the editor to edit one of their own lessons. The editor
  // fetches the full lesson and warns before replacing any in-progress work, so
  // we only hand it which lesson to load (via sessionStorage, consumed once on
  // the editor's mount). stopPropagation keeps the card's preview click from
  // also firing.
  const editLesson = (e, summary) => {
    e.stopPropagation();
    try {
      sessionStorage.setItem(EDIT_REQUEST_KEY, summary.id);
    } catch {
      /* ignore — navigation below still works, the editor just won't preload */
    }
    navigate("/editor");
  };

  // Open the delete-confirmation dialog for one of the user's own lessons.
  // stopPropagation keeps the card's preview click from also firing.
  const askDelete = (e, summary) => {
    e.stopPropagation();
    setDeleting(summary);
    setDeleteText("");
    setDeleteError("");
  };

  const closeDelete = () => {
    if (deleteBusy) return; // don't abandon an in-flight request
    setDeleting(null);
  };

  // The title the user must type to confirm. Mirrors the fallback the card and
  // backend use for an untitled lesson, so an "Untitled Lesson" card is
  // confirmable by typing exactly that.
  const deleteTarget = deleting ? deleting.title || "Untitled Lesson" : "";
  const deleteConfirmed = deleteText.trim() === deleteTarget;

  const confirmDelete = async () => {
    if (!deleting || !deleteConfirmed) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteLesson(deleting.id, accessToken);
      // Drop it from whichever list held it (published gallery or drafts) so it
      // disappears immediately.
      setLessons((prev) => prev.filter((l) => l.id !== deleting.id));
      setDrafts((prev) => prev.filter((l) => l.id !== deleting.id));
      toast(`Deleted “${deleteTarget}”.`);
      setDeleting(null);
    } catch (err) {
      setDeleteError(err.message || "Could not delete this lesson.");
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-16 text-foreground">
      <AppHeader
        title="Lesson hub"
        left={
          <Tooltip>
            <TooltipTrigger asChild>
              <RouterLink
                to="/editor"
                aria-label="editor"
                className="mr-1 inline-flex shrink-0 items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-sm font-medium text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10 md:px-4"
              >
                <PencilIcon data-icon="inline-start" />
                <span className="hidden md:inline">Editor</span>
              </RouterLink>
            </TooltipTrigger>
            <TooltipContent className="md:hidden">Editor</TooltipContent>
          </Tooltip>
        }
      >
        <NavActions current="hub" />
      </AppHeader>

      <div className="mx-auto max-w-5xl px-4 pt-6">
        <div className="mb-4 flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Browse lessons shared by the community. Open one to preview it.
          </p>
          {lessonHubEnabled && (
            <div className="flex shrink-0 items-center gap-0.5">
              <IconActionButton
                tooltip="Subscribe to the latest lessons (RSS)"
                aria-label="latest lessons RSS feed"
                asChild
              >
                <a
                  href={lessonsFeedUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <RssIcon />
                </a>
              </IconActionButton>
              <IconActionButton
                tooltip="Refresh"
                aria-label="refresh"
                disabled={loading}
                onClick={() => {
                  load();
                  loadDrafts();
                }}
              >
                <RefreshCwIcon />
              </IconActionButton>
            </div>
          )}
        </div>

        {lessonHubEnabled && drafts.length > 0 && (
          <div className="mb-8">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <CloudIcon className="size-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Your drafts</h2>
              <p className="text-sm text-muted-foreground">
                Backed up to the cloud, visible only to you. Open one to edit
                and publish it.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
              {drafts.map((lesson) => (
                <LessonCard
                  key={lesson.id}
                  lesson={lesson}
                  draft
                  editable
                  onEdit={editLesson}
                  onDelete={askDelete}
                />
              ))}
            </div>
          </div>
        )}

        {lessonHubEnabled && !loading && !error && lessons.length > 0 && (
          <Field className="mb-4">
            <FieldLabel htmlFor="hub-search" className="sr-only">
              Search lessons
            </FieldLabel>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="hub-search"
                placeholder="Search lessons by title or author…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9 pr-9"
              />
              {query && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="clear search"
                  onClick={() => setQuery("")}
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                >
                  <XIcon />
                </Button>
              )}
            </div>
          </Field>
        )}

        {!lessonHubEnabled && (
          <Alert className="border-primary/40 bg-primary/10 text-primary">
            <AlertDescription className="text-primary">
              The lesson hub is not configured (VITE_API_URL is missing).
            </AlertDescription>
          </Alert>
        )}

        {lessonHubEnabled && error && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-2">
              {error}
              <Button variant="ghost" size="sm" onClick={load}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {lessonHubEnabled && loading && <LessonGridSkeleton />}

        {lessonHubEnabled && !loading && !error && lessons.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-12 text-center">
            <p className="mb-1 text-lg font-semibold">No lessons yet</p>
            <p className="text-sm text-muted-foreground">
              Be the first to publish — build a lesson in the editor and press{" "}
              <strong>Publish to hub</strong>.
            </p>
          </div>
        )}

        {lessonHubEnabled &&
          !loading &&
          !error &&
          lessons.length > 0 &&
          searching &&
          visibleLessons.length === 0 && (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <p className="mb-1 text-lg font-semibold">No matches</p>
              <p className="text-sm text-muted-foreground">
                No lessons match &ldquo;{debouncedQuery}&rdquo;. Try a different
                search.
              </p>
            </div>
          )}

        {lessonHubEnabled &&
          !loading &&
          !error &&
          visibleLessons.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
              {visibleLessons.map((lesson) => (
                <LessonCard
                  key={lesson.id}
                  lesson={lesson}
                  editable={Boolean(
                    user && lesson.authorId && lesson.authorId === user.id,
                  )}
                  onEdit={editLesson}
                  onDelete={askDelete}
                />
              ))}
            </div>
          )}
      </div>

      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(next) => !next && closeDelete()}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this lesson?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This permanently deletes <strong>{deleteTarget}</strong>. This
            can&rsquo;t be undone. To confirm, type the lesson&rsquo;s name
            below.
          </p>
          <Field>
            <FieldLabel htmlFor="hub-delete-name" className="sr-only">
              Lesson name
            </FieldLabel>
            <Input
              id="hub-delete-name"
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
              Cancel
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
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
