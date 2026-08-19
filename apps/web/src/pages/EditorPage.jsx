import { hasApi } from "@spelling-creator/core/config";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { DocumentMeta } from "../lib/seo.jsx";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import {
  BracesIcon,
  ChevronDownIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CircleHelpIcon,
  CloudIcon,
  CloudUploadIcon,
  CodeIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  FileTextIcon,
  FileUpIcon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HistoryIcon,
  LibraryIcon,
  PlusIcon,
  PrinterIcon,
  SaveIcon,
  SparklesIcon,
  SpellCheckIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import PageBar from "../components/layout/PageBar.jsx";
import SectionOutline from "../components/editor/SectionOutline.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Field, FieldLabel } from "../components/ui/field.jsx";
import { Input } from "../components/ui/input.jsx";
import { Spinner } from "../components/ui/spinner.jsx";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "../components/ui/tooltip.jsx";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../components/ui/select.jsx";
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
import { cn } from "../lib/utils.js";
import SectionCard from "../components/SectionCard.jsx";
import { SectionsSkeleton } from "../components/Skeletons.jsx";
import { LiveInput } from "../components/LiveField.jsx";
import CollaborateDialog from "../components/CollaborateDialog.jsx";
import CollabCursors from "../components/CollabCursors.jsx";
import CollabChat from "../components/CollabChat.jsx";
import FirstLessonWizard from "../components/FirstLessonWizard.jsx";
import AiLessonIdeaDialog from "../components/AiLessonIdeaDialog.jsx";
import HistoryDialog, { timeAgo } from "../components/HistoryDialog.jsx";
import VariationsDialog from "../components/VariationsDialog.jsx";
import LessonsDialog from "../components/LessonsDialog.jsx";
import MergeDialog from "../components/MergeDialog.jsx";
import ProposeChangesDialog from "../components/ProposeChangesDialog.jsx";
// The preview dialog renders the working doc with the very same read-only
// renderer the public lesson page uses — no docx, no mammoth, nothing to fetch.
import LessonView from "../components/LessonView.jsx";
import { AGE_RANGES } from "@spelling-creator/core/ageRanges";
import { newId } from "@spelling-creator/core/id";
import { extractCapitalizedWords } from "@spelling-creator/core/spelling";
import { useLessonGit } from "../lib/git/useLessonGit.js";
import {
  DEFAULT_BRANCH as engineDefaultBranch,
  branchLabel,
  toBranchName,
} from "@spelling-creator/core/git/refs";
import { diffDocs } from "@spelling-creator/core/git/ops";
import { repoIdFor } from "@spelling-creator/core/git/doc";
// The git engine (isomorphic-git + LightningFS) is loaded on demand rather than
// imported directly, so it stays out of the bundle every homepage and hub visitor
// downloads. loadGitEngine() memoises the import; by the time any of these flows
// runs, useLessonGit has already fetched the chunk.
import { loadGitEngine } from "../lib/git/load.js";
import {
  listLessons,
  getLesson,
  createLesson,
  saveLessonDoc,
  saveLessonMeta,
  deleteLesson,
  getCurrentLessonId,
  setCurrentLessonId,
  loadWizardSeen,
  saveWizardSeen,
  migrateLocalStorage,
  migrateToLibrary,
} from "@spelling-creator/core/browser/storage";
import { convertDocImages } from "@spelling-creator/core/browser/imageRef";
import { ensureImagesUploaded } from "@spelling-creator/core/imagesClient";
// exportJson is a Blob and an <a> — no heavy dependency, so it stays static.
// The docx/PDF/import pipeline is not: it loads on demand through
// lib/exports/load.js. See the comment in lib/exports/engine.js.
import { exportJson } from "@spelling-creator/core/browser/jsonExport";
import { importJsonFile } from "@spelling-creator/core/jsonImport";
import { loadExportEngine } from "../lib/exports/load.js";
import { hasGoogleDrive } from "@spelling-creator/core/config";
import {
  publishLesson,
  updateLesson,
  fetchLesson,
  EDIT_REQUEST_KEY,
  FORK_REQUEST_KEY,
} from "@spelling-creator/core/lessons";
import {
  fetchPullRequests,
  mergePullRequest,
} from "@spelling-creator/core/pulls";
import { useAuth } from "../lib/auth.jsx";
import { useCollaboration } from "../lib/collab.js";
import { useSelectionBroadcast } from "../lib/useSelectionBroadcast.js";
import { useDragAutoScroll } from "../lib/useDragAutoScroll.js";
import {
  idSelector,
  scrollToElement,
  useScrollAnchor,
} from "../lib/useScrollAnchor.js";

// Where the user was last editing, so re-entering the editor doesn't drop them
// at the top of a document that runs to ~54 phone screens.
//
// sessionStorage rather than the IndexedDB draft store: this is per-tab and
// should expire with the tab. Reopening a lesson tomorrow ought to start at the
// beginning; coming back from the hub or a reload, five minutes later, ought
// not to.
const FOCUS_KEY = "s2c-lesson-maker:editor-focus";

// Which sections are collapsed to their header. Same storage reasoning as
// FOCUS_KEY: a view preference for this tab, not part of the lesson.
const COLLAPSED_KEY = "s2c-lesson-maker:editor-collapsed";

// How long a dragged block must hover a collapsed section before it springs
// open. Long enough that dragging *past* a collapsed section on the way
// somewhere else doesn't keep re-flowing the page under the pointer.
const SPRING_OPEN_MS = 500;

// The section the viewport is currently inside: the first one whose bottom edge
// is still below the app bar. Used to keep the user's place across a
// collapse-all / expand-all, which changes the page height by ~20x.
function currentSectionEl() {
  // Measured off the bar itself rather than read from --header-h, which is a
  // calc() with an env() in it and doesn't resolve to a bare number.
  const top =
    document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
  for (const el of document.querySelectorAll("[data-section-id]")) {
    if (el.getBoundingClientRect().bottom > top) return el;
  }
  return null;
}

// The starter document a fresh editor opens with. Any persisted draft is loaded
// asynchronously from IndexedDB on mount (see the hydration effect) and replaces
// this once available.
function createInitialDoc(t) {
  return { title: t("defaultDoc.title"), sections: [] };
}

// Apply a finished block drag to the document: pull the dragged block out of the
// section it came from and slot it into the section it was dropped on, before or
// after the block the insertion line was showing. The two sections are often the
// same (a plain reorder), but need not be — a block can be dragged into any
// section, including an empty one, where `overId` is null and it simply lands at
// the end. Returns the document unchanged if the drag was a no-op, so a drag that
// ends where it started doesn't dirty the draft (or churn collaborators).
function applyBlockDrag(
  doc,
  { blockId, fromSectionId, overSectionId, overId, overPos },
) {
  const from = doc.sections.find((s) => s.id === fromSectionId);
  const block = from?.blocks.find((b) => b.id === blockId);
  if (!block) return doc;

  const sections = doc.sections.map((s) =>
    s.id === fromSectionId
      ? { ...s, blocks: s.blocks.filter((b) => b.id !== blockId) }
      : s,
  );
  const targetIndex = sections.findIndex((s) => s.id === overSectionId);
  if (targetIndex === -1) return doc;

  // The insertion index is measured against the target's blocks with the dragged
  // block already removed, so a within-section move can't be off by one.
  const target = sections[targetIndex];
  const blocks = [...target.blocks];
  let at = blocks.length;
  if (overId) {
    const i = blocks.findIndex((b) => b.id === overId);
    if (i !== -1) at = overPos === "after" ? i + 1 : i;
  }
  blocks.splice(at, 0, block);

  const unchanged =
    fromSectionId === overSectionId &&
    blocks.every((b, i) => b.id === from.blocks[i].id);
  if (unchanged) return doc;

  sections[targetIndex] = { ...target, blocks };
  return { ...doc, sections };
}

export default function EditorPage() {
  const { t } = useTranslation("editor");
  const [doc, setDoc] = useState(() => createInitialDoc(t));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [ideaDialogOpen, setIdeaDialogOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [busy, setBusy] = useState(null); // 'docx' | 'pdf' | 'gdocs' | 'publish' | 'import' | null
  const [previewOpen, setPreviewOpen] = useState(false);
  // Word-import flow. `importWarnOpen` shows the "import is best-effort" warning
  // before the file picker; `importError` holds the reason a chosen file was
  // rejected (shown in a dialog — the editor is left untouched). The hidden
  // file input is triggered programmatically from the warning dialog.
  const [importWarnOpen, setImportWarnOpen] = useState(false);
  const [importError, setImportError] = useState(null);
  // Which picker the rejection dialog's "Try another file" should re-open.
  const [importErrorSource, setImportErrorSource] = useState("word");
  const importInputRef = useRef(null);
  // JSON import reuses the same rejection dialog (importError) and overwrite
  // confirmation, but skips the best-effort warning — the JSON format is a
  // lossless round-trip of our own model. Its own hidden picker.
  const jsonInputRef = useRef(null);

  // Which of this device's lessons is open. Every lesson in the library
  // (core/browser/storage.js) has one of these ids, and it is also the name of
  // the lesson's git repository until it is published and takes the hub's id
  // instead — so `localId` is what makes switching lessons switch documents and
  // histories together. `localLessons` is the library itself, read for the
  // lessons panel and refreshed whenever one is added or removed; null until
  // it has been read once.
  const [localId, setLocalId] = useState(null);
  const [localLessons, setLocalLessons] = useState(null);

  // Hub-editing state. `editingId` is the id of a published lesson currently
  // loaded for editing (so "Publish" becomes "Update"); null when authoring a
  // fresh lesson. It's stored on the library record (see effect below) so the
  // status survives reloads and tab closes until the user forks into a new
  // lesson. `editLoading` covers the fetch of a lesson to edit.
  const [editingId, setEditingId] = useState(null);
  // Whether the lesson loaded for editing is published to the hub or a private
  // draft. Only meaningful when `editingId` is set; it tunes the "Save to cloud"
  // actions and the status chip. Persisted so it survives reloads.
  const [editingPublished, setEditingPublished] = useState(true);
  const [editLoading, setEditLoading] = useState(false);

  // Version control. The lesson is kept in a real git repository in the browser,
  // one file per content block (see lib/git/), committed automatically whenever
  // the user pauses. `forkedFrom` is the lesson this one was forked from, if any:
  // it's what lets us later pull the original's changes in, merging the two
  // histories against the commit they diverged from. Persisted with the draft.
  const [forkedFrom, setForkedFrom] = useState(null);
  const [forkedFromTitle, setForkedFromTitle] = useState("");
  // Whether this fork's work can be offered back to the original at all — which
  // it can, by anyone but the original's own author, since a proposal writes
  // nothing until someone with the authority to merge it says so.
  const [canPropose, setCanPropose] = useState(false);
  // The "propose changes to the original" dialog, and whether a submission is in
  // flight (it packs the repository and uploads it, so it isn't instant).
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposing, setProposing] = useState(false);
  // A pull request being reviewed, once fetched: the editor is opened with
  // ?pull=<id> from the lesson page's proposals list (see PullRequestsSection).
  const [reviewPull, setReviewPull] = useState(null);
  // A merge the user is being asked to settle: the result of prepareMerge, held
  // until they've chosen how to resolve any conflicts (see MergeDialog).
  const [merge, setMerge] = useState(null);
  const [merging, setMerging] = useState(false);
  // What to do once the merge is settled:
  //   "pull"          just take the original's changes into this fork
  //   "pull-request"  ...then land it in the lesson we're reviewing a proposal
  //                   for (author / trusted collaborator only, server-enforced)
  //   "publish"       a save found the hub ahead of us; merge, then save again
  const [mergeIntent, setMergeIntent] = useState("pull");
  // The variation being folded into the main lesson, so the merge dialog and the
  // toast afterwards can name it.
  const [mergeVariation, setMergeVariation] = useState(null);
  // The proposal a try-out is for. `reviewPull` deliberately stays null on that
  // path (it is what makes a confirm *land* the proposal), so the title it needs
  // for the dialog and the merge message is held separately.
  const [mergeProposalTitle, setMergeProposalTitle] = useState("");

  const {
    enabled: authEnabled,
    accessToken,
    loading: authLoading,
    user,
  } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const showPublish = hasApi() && authEnabled;

  // The editor's two big panels are addressed by URL — /editor/history and
  // /editor/collaborate — rather than held as component state. They were the
  // largest things in the app with no address at all: 300 and 800 lines of UI
  // that the back button did nothing to, and that nobody could link a
  // collaborator to. `panel` comes from the route (see EditorShell.jsx), and an
  // unrecognised value simply opens nothing.
  //
  // Navigation carries `location.search` forward. The editor's two deep links
  // both live in the query string — `?join=<code>` for a collaboration invite
  // and `?pull=<id>&lesson=<id>` for a proposal to review — and dropping the
  // query on the way into a panel would break the very flow that opened it.
  const location = useLocation();
  // The first segment under /editor, or "" at /editor itself. Read from the
  // path rather than a route param because the route is a splat — see
  // EditorShell.jsx for why it has to be.
  const panel = location.pathname.replace(/^\/editor\/?/, "").split("/")[0];
  const historyOpen = panel === "history";
  const collabOpen = panel === "collaborate";
  const variationsOpen = panel === "variations";
  const lessonsOpen = panel === "lessons";
  //
  // Opening pushes; closing *replaces*. Both pushing would leave the history as
  // [/editor, /editor/history, /editor], so Back from a panel you had just
  // closed would land on the panel's own URL and reopen it — the opposite of
  // what pressing Back means. (Caught in review on #40.)
  //
  // Replacing costs one dead Back press: the panel's entry becomes a second
  // /editor, so backing out of the editor afterwards takes two. That is the
  // better of the two, and better than the alternative of replacing on open as
  // well, which would make Back from an *open* panel leave the editor entirely
  // rather than close the panel — the common case, and the one worth getting
  // right.
  const openPanel = useCallback(
    (name) =>
      navigate(
        {
          pathname: name ? `/editor/${name}` : "/editor",
          search: location.search,
        },
        { replace: !name },
      ),
    [navigate, location.search],
  );

  // A thin shim over sonner's toast() that keeps every call site below
  // exactly as it was under the old { severity, message, link?, route? }
  // shape (originally an object handed to setState, rendered by a single
  // MUI Snackbar/Alert at the bottom of this component) — link opens an
  // external URL, route navigates within the app; a toast has at most one.
  const notify = useCallback(
    ({ severity = "info", message, link, route }) => {
      const show = toast[severity] || toast.info;
      show(message, {
        action: link
          ? {
              label: link.label,
              onClick: () =>
                window.open(link.href, "_blank", "noopener,noreferrer"),
            }
          : route
            ? { label: route.label, onClick: () => navigate(route.to) }
            : undefined,
      });
    },
    [navigate],
  );

  // Real-time collaboration over a Cloudflare Durable Object. The hook watches
  // `doc` to broadcast local edits and calls setDoc with documents received from
  // the room. Identity labels our own chat bubbles; the access token authenticates
  // the WebSocket (only signed-in users may host or join).
  const identity = useMemo(
    () => ({
      name:
        user?.user_metadata?.display_name ||
        user?.user_metadata?.full_name ||
        user?.user_metadata?.name ||
        (user?.email ? user.email.split("@")[0] : ""),
      email: user?.email || "",
      // A profile picture if the auth provider gave us one — used for the
      // floating editing indicator and the collaborator roster.
      avatarUrl:
        user?.user_metadata?.avatar_url || user?.user_metadata?.picture || "",
    }),
    [user],
  );
  const collab = useCollaboration({
    doc,
    onRemoteDoc: setDoc,
    identity,
    accessToken,
  });

  // Editor state hydrates from IndexedDB (below), and `hydrated` gates this so
  // version control never commits the empty starter doc over a real draft's
  // history before that draft has loaded.
  const [hydrated, setHydrated] = useState(false);
  const git = useLessonGit({
    doc,
    editingId,
    localId,
    identity,
    enabled: hydrated,
  });

  // First-lesson wizard. Auto-shows once for newcomers (tracked by a
  // localStorage flag); dismissing it sets the flag so it won't reappear. The
  // help button reopens it on demand without touching the flag.
  const [wizardOpen, setWizardOpen] = useState(false);

  // The document as it was last written to storage. Compared by identity, so
  // opening a lesson doesn't immediately save the very document it just read
  // (which would restamp its "edited" time and reorder the library for a lesson
  // nobody has touched). Every edit makes a new object, so anything the user
  // actually does compares unequal.
  const savedDocRef = useRef(null);

  // Take a lesson out of the library and into the editor. The whole of the
  // editor's per-lesson state changes together — document, hub attachment,
  // publish status, fork origin — and `localId` changing swaps the git
  // repository under useLessonGit as well.
  const adoptRecord = useCallback((record) => {
    const next = record.doc || { title: "", sections: [] };
    setLocalId(record.id);
    setDoc(next);
    savedDocRef.current = next;
    setEditingId(record.lessonId || null);
    setEditingPublished(record.published !== false);
    setForkedFrom(record.forkedFrom || null);
    setCurrentLessonId(record.id);
  }, []);

  // Editor state lives in IndexedDB now (async), so we hydrate it on mount
  // rather than synchronously at useState time. `hydrated` gates the persistence
  // effects below so they don't write the empty starter doc over a saved lesson
  // before it loads, and defers the hub edit/fork request until the library is
  // there to put the lesson into. The two migrations run first, in order: the
  // pre-IndexedDB draft moves into IndexedDB, then the single working document
  // becomes the library's first lesson. Both are idempotent no-ops afterwards.
  // Guarded by a ref rather than by a cancellation flag, and the difference
  // matters here. This effect *writes*: a device with an empty library has its
  // first lesson made for it, so there is always one open. StrictMode invokes
  // the effect twice in development, and two runs racing to discover an empty
  // library would each create a lesson and leave an untitled twin behind — while
  // the usual "cancelled" cleanup would abandon the first run's work after the
  // second had already been told not to start. A ref survives the double-invoke
  // (the instance is reused), so exactly one run happens and it finishes; a real
  // remount gets a fresh ref, and hydrates again as it should.
  const hydrateRef = useRef(false);
  useEffect(() => {
    if (hydrateRef.current) return;
    hydrateRef.current = true;
    (async () => {
      await migrateLocalStorage();
      await migrateToLibrary();
      const [currentId, seen] = await Promise.all([
        getCurrentLessonId(),
        loadWizardSeen(),
      ]);
      // A device with a library but no current lesson (its last one was deleted
      // in another tab) opens the most recent.
      let record = currentId ? await getLesson(currentId) : null;
      if (!record) {
        const [newest] = await listLessons();
        record = newest ? await getLesson(newest.id) : null;
      }
      if (!record) record = await createLesson({ doc: createInitialDoc(t) });
      adoptRecord(record);
      if (!seen) setWizardOpen(true);
      setHydrated(true);
    })();
    // Mount-only: `t` and adoptRecord are stable enough that re-hydrating on a
    // language change would only throw away in-progress work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The lesson this one was forked from: its name (for the sync and propose
  // buttons and the merge dialog), and whether offering work back to it makes
  // sense at all. Fetched lazily; a failure just leaves the generic wording.
  useEffect(() => {
    if (!forkedFrom) {
      setForkedFromTitle("");
      setCanPropose(false);
      return;
    }
    let cancelled = false;
    fetchLesson(forkedFrom, accessToken)
      .then((lesson) => {
        if (cancelled) return;
        setForkedFromTitle(lesson.title || "");
        // Anyone signed in may propose changes to a lesson — a proposal writes
        // nothing until its author (or a trusted collaborator) merges it. The one
        // person it makes no sense for is the original's own author: they'd just
        // save it. The Worker refuses that case too.
        setCanPropose(Boolean(user) && lesson.authorId !== user?.id);
      })
      .catch(() => {
        /* the original may have been deleted — the sync will report it */
      });
    return () => {
      cancelled = true;
    };
  }, [forkedFrom, user, accessToken]);

  const closeWizard = () => {
    setWizardOpen(false);
    saveWizardSeen();
  };

  const openWizard = () => setWizardOpen(true);

  // While collaborating, share our text selection so others see our avatar
  // float over what we're editing (and we see theirs via CollabCursors).
  useSelectionBroadcast({
    active: collab.active,
    onSelect: collab.setLocalSelection,
  });

  // An invite link deep-links here with `?join=<code>`. Open the collaboration
  // dialog (prefilled with the code) once when we arrive that way.
  const joinCode = searchParams.get("join") || "";
  const joinHandledRef = useRef(false);
  useEffect(() => {
    if (joinCode && !joinHandledRef.current) {
      joinHandledRef.current = true;
      openPanel("collaborate");
    }
  }, [joinCode, openPanel]);

  // Refs mirror the latest doc/editingId so the one-shot "load for editing"
  // effect below can read current values without re-subscribing to every edit.
  // `editRequestedRef` makes that effect process the hub's edit request at most
  // once for this component instance (it survives React StrictMode's dev-only
  // double-invoke, since the same instance is reused).
  const docRef = useRef(doc);
  const editingIdRef = useRef(editingId);
  const editRequestedRef = useRef(false);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  useEffect(() => {
    editingIdRef.current = editingId;
  }, [editingId]);

  // Persist the open lesson's document, debounced: typing into a large lesson
  // shouldn't rewrite the whole document on every keystroke (the synchronous
  // write janks low-end machines). We save ~600ms after edits pause, and flush a
  // pending save on unmount so the last keystrokes aren't lost.
  //
  // The pending save carries the lesson id it belongs to, not just the document:
  // switching lessons changes both at once, and a save that outlived its lesson
  // would write one lesson's text into another's record.
  const pendingSaveRef = useRef(null);
  useEffect(() => {
    if (!hydrated || !localId) return;
    // Just opened, and unedited since — nothing has changed to write.
    if (doc === savedDocRef.current) return;
    pendingSaveRef.current = { id: localId, doc };
    const timer = setTimeout(() => {
      pendingSaveRef.current = null;
      savedDocRef.current = doc;
      saveLessonDoc(localId, doc);
    }, 600);
    return () => clearTimeout(timer);
  }, [doc, localId, hydrated]);
  useEffect(
    () => () => {
      const pending = pendingSaveRef.current;
      if (pending) saveLessonDoc(pending.id, pending.doc);
    },
    [],
  );

  // Persist where this lesson lives besides here: the hub lesson it's attached
  // to, whether that lesson is published or a private draft, and the lesson it
  // was forked from (so the link home survives a reload and the fork can still
  // be synced with its original days later). All three belong to the library
  // record rather than the document, so they travel with the lesson when you
  // switch to another and back.
  useEffect(() => {
    if (!hydrated || !localId) return;
    saveLessonMeta(localId, {
      lessonId: editingId,
      published: editingId ? editingPublished : true,
      forkedFrom,
    });
  }, [localId, editingId, editingPublished, forkedFrom, hydrated]);

  // ---- the library ---------------------------------------------------------
  //
  // Everything below moves the editor between lessons. There is one rule they
  // all obey: whatever is on screen is written down *before* it is replaced.
  // That is the whole reason none of these has to ask permission first — the
  // editor used to hold a single working document, so opening anything meant
  // destroying what you had, and three flows (edit, fork, import) each needed a
  // "Replace your current work?" dialog to guard it. A lesson you leave is a
  // lesson still in the list.

  const refreshLocalLessons = useCallback(async () => {
    setLocalLessons(await listLessons());
  }, []);

  // commitNow keeps a stable identity (it is keyed to the repository), unlike
  // the `git` object, which is rebuilt every render.
  const commitNow = git.commitNow;

  // Get the open lesson fully onto disk: the debounced document save, then a
  // version-control checkpoint. Both are skipped when there's nothing new —
  // committing an unchanged document is already a no-op (see repo.js).
  const flushCurrentLesson = useCallback(async () => {
    if (!localId) return;
    pendingSaveRef.current = null;
    const current = docRef.current;
    if (current !== savedDocRef.current) {
      savedDocRef.current = current;
      await saveLessonDoc(localId, current);
    }
    await commitNow();
  }, [commitNow, localId]);

  const openLocalLesson = useCallback(
    async (id) => {
      if (!id || id === localId) return;
      await flushCurrentLesson();
      const record = await getLesson(id);
      if (!record) {
        // Deleted in another tab, most likely. Re-read rather than insist.
        await refreshLocalLessons();
        return;
      }
      adoptRecord(record);
    },
    [adoptRecord, flushCurrentLesson, localId, refreshLocalLessons],
  );

  const startNewLesson = useCallback(async () => {
    // Already in an untouched lesson? That *is* the new lesson. Making another
    // would leave a trail of untitled empties behind every time someone pressed
    // the button twice. "Untouched" means no sections, no hub lesson behind it,
    // and the title still exactly as the editor wrote it — a lesson somebody has
    // named is one they have started, however empty it still looks.
    const current = docRef.current;
    const untouched =
      !editingIdRef.current &&
      (current?.sections?.length ?? 0) === 0 &&
      (!current?.title || current.title === t("defaultDoc.title"));
    if (untouched) return null;
    await flushCurrentLesson();
    const record = await createLesson({ doc: createInitialDoc(t) });
    adoptRecord(record);
    await refreshLocalLessons();
    return record;
  }, [adoptRecord, flushCurrentLesson, refreshLocalLessons, t]);

  const duplicateLocalLesson = useCallback(
    async (id) => {
      if (id === localId) await flushCurrentLesson();
      const source = await getLesson(id);
      if (!source) return null;

      const doc = {
        ...(source.doc || createInitialDoc(t)),
        title: t("labels.copyOf", {
          title: source.doc?.title || t("labels.untitledLesson"),
        }),
      };
      // Unattached on purpose: a copy is a lesson of its own, so saving it to
      // the cloud creates a separate one rather than overwriting what it was
      // copied from — while remembering what that was, so the two can still be
      // merged later.
      const record = await createLesson({
        doc,
        forkedFrom: source.lessonId || source.forkedFrom || null,
      });
      try {
        // A real clone of the repository, not just of the text: the copy keeps
        // the original's history and shares its commit oids.
        const engine = await loadGitEngine();
        await engine.forkLocalRepo(
          repoIdFor(source.lessonId, source.id),
          record.id,
        );
      } catch {
        /* no history to carry over — the copy starts a fresh one */
      }
      await refreshLocalLessons();
      return record;
    },
    [flushCurrentLesson, localId, refreshLocalLessons, t],
  );

  const removeLocalLesson = useCallback(
    async (id) => {
      // Drop any save still in flight for it, so nothing recreates what we are
      // about to delete.
      if (pendingSaveRef.current?.id === id) pendingSaveRef.current = null;
      const record = await getLesson(id);
      await deleteLesson(id);
      try {
        const engine = await loadGitEngine();
        // The local repository only. A lesson that reached the cloud keeps its
        // history there, and the lesson page clones it back on demand.
        await engine.deleteRepo(repoIdFor(record?.lessonId, id));
      } catch {
        /* the repo may never have existed */
      }

      if (id === localId) {
        const remaining = (await listLessons()).filter((l) => l.id !== id);
        const next = remaining[0]
          ? await getLesson(remaining[0].id)
          : await createLesson({ doc: createInitialDoc(t) });
        adoptRecord(next);
      }
      await refreshLocalLessons();
    },
    [adoptRecord, localId, refreshLocalLessons, t],
  );

  const renameLocalLesson = useCallback(
    async (id, title) => {
      if (id === localId) {
        // The open lesson retitles like any other edit — the auto-save above
        // carries it (and the library's copy of the title) from here.
        setDoc((d) => ({ ...d, title }));
      } else {
        const record = await getLesson(id);
        if (record?.doc) await saveLessonDoc(id, { ...record.doc, title });
      }
      await refreshLocalLessons();
    },
    [localId, refreshLocalLessons],
  );

  // Deep links into the library: the sidebar lists the lessons on this device
  // and links here with ?local=<id>, and its "New lesson" button with ?new=1.
  // The editor is already mounted when either is followed from another page, so
  // a param is what carries the intent across; it's stripped as soon as it's
  // read, which is also what stops this from firing twice.
  const localParam = searchParams.get("local");
  const newParam = searchParams.get("new");
  useEffect(() => {
    if (!hydrated || (!localParam && !newParam)) return;
    const params = new URLSearchParams(location.search);
    params.delete("local");
    params.delete("new");
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "" },
      { replace: true },
    );
    if (newParam) startNewLesson();
    else openLocalLesson(localParam);
  }, [
    hydrated,
    localParam,
    newParam,
    location.pathname,
    location.search,
    navigate,
    openLocalLesson,
    startNewLesson,
  ]);

  // Which sections are collapsed to their header.
  //
  // Local view state, deliberately *not* part of the document: it isn't content,
  // it must never reach the exporters, and it's never broadcast to
  // collaborators — the same reasoning as SectionCard's activeBlockId. What one
  // person folds away to get some screen back is theirs, not everyone's.
  //
  // It lives here rather than in each card so "collapse all" is possible, and
  // reaches each card as a plain boolean, so toggling one section doesn't
  // re-render the others. Declared above the restore effect below, which reads
  // it.
  const [collapsedIds, setCollapsedIds] = useState(() => {
    try {
      const raw = sessionStorage.getItem(COLLAPSED_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedIds]));
    } catch {
      // Private mode / quota — collapsing still works, it just won't survive a
      // reload.
    }
  }, [collapsedIds]);

  // `next` is optional: omitted it toggles, passed it forces a state (the
  // find-in-page and drag spring-open paths both only ever want "expand").
  const toggleCollapse = useCallback((id, next) => {
    setCollapsedIds((prev) => {
      const wanted = next ?? !prev.has(id);
      if (wanted === prev.has(id)) return prev;
      const out = new Set(prev);
      if (wanted) out.add(id);
      else out.delete(id);
      return out;
    });
  }, []);

  // Remember which block the user was last typing in.
  //
  // A block id, not a scroll offset: block heights change as the lesson is
  // edited and as images load, so a pixel position points at something else by
  // the time it's used, while an id still means the thing you were working on.
  //
  // A capture-free focusin listener writing straight to sessionStorage keeps
  // this out of React entirely. Lifting SectionCard's activeBlockId up to this
  // page would re-render every section on each focus change — the exact cost
  // that keeping it local avoids on a 108-block document.
  useEffect(() => {
    const onFocusIn = (e) => {
      const el = e.target?.closest?.("[data-block-id]");
      if (!el) return;
      try {
        sessionStorage.setItem(FOCUS_KEY, el.dataset.blockId);
      } catch {
        // Private mode / quota. Position restore is a convenience, never fatal.
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // ...and go back there once the draft has hydrated and the sections exist.
  // Once per mount only (restoredRef), so it can never yank the page out from
  // under someone who has already started scrolling.
  const restoredRef = useRef(false);
  // collapsedIds is read inside the animation frame below, but must not be a
  // dependency: a collapse landing between the effect and the frame would run
  // the cleanup — cancelling the pending frame — and then bail on
  // restoredRef, so the restore would be dropped and never rescheduled. A ref
  // gets the current value without giving the effect a reason to re-run.
  const collapsedIdsRef = useRef(collapsedIds);
  useEffect(() => {
    collapsedIdsRef.current = collapsedIds;
  }, [collapsedIds]);
  useEffect(() => {
    if (!hydrated || restoredRef.current) return;
    restoredRef.current = true;
    let blockId = null;
    try {
      blockId = sessionStorage.getItem(FOCUS_KEY);
    } catch {
      return;
    }
    if (!blockId) return;
    // One frame, so the sections that just rendered have been laid out.
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(idSelector("data-block-id", blockId));
      if (!el) return;
      // The block may be inside a section the user collapsed before they left.
      // Go to that section's card rather than expanding it behind their back —
      // a collapsed section is a decision, and the header still gets them to
      // the right place.
      const card = el.closest("[data-section-id]");
      if (card && collapsedIdsRef.current.has(card.dataset.sectionId)) {
        scrollToElement(card, { smooth: false });
        return;
      }
      // `center`, not `start`: a block aligned to the top of the page would sit
      // underneath its own section's sticky header. And not smooth — this is
      // where you already were, so it shouldn't play as a journey.
      scrollToElement(el, { block: "center", smooth: false });
    });
    return () => cancelAnimationFrame(raf);
  }, [hydrated]);

  // Adopt a fetched lesson into the editor. Each mode lands somewhere different
  // in this device's library, and — this is the part that used to need a
  // "Replace your current work?" dialog — none of them touches the lesson that
  // was on screen. Whatever you were doing is saved and stays in the list.
  //
  //   import  a new lesson of its own, keeping the document's own title
  //   fork    a new lesson, unattached, titled "… (copy)"
  //   edit    the lesson you already hold for it, if you hold one — otherwise a
  //           new lesson attached to it, so "Publish" means "Update" on the row
  //           it came from
  const applyEdit = async ({
    id,
    doc: nextDoc,
    mode,
    source,
    published,
    forkedFrom: incomingFork,
  }) => {
    await flushCurrentLesson();

    if (mode === "import") {
      // An imported document has no relationship to whatever was in the editor
      // before, so it gets a lesson — and therefore a history — of its own,
      // starting at the import rather than continuing someone else's timeline.
      adoptRecord(await createLesson({ doc: nextDoc }));
      await refreshLocalLessons();
      notify({
        severity: "info",
        message:
          source === "json"
            ? t("messages.importedJson")
            : t("messages.importedWord"),
      });
      return;
    }

    if (mode === "fork") {
      // Forking *clones the lesson's repository*: the copy keeps the original's
      // full history and, because git addresses commits by content, shares its
      // ancestry — which is what lets the fork be merged with the original later,
      // against the exact commit the two diverged from.
      //
      // The library record is created first because its id is the name of the
      // repository the clone lands in (see core/browser/storage.js).
      //
      // A lesson published before this feature has no repo to clone. The fork
      // still works and still gets history from here on; it just has no common
      // ancestor with the original, so a later sync compares the two directly.
      const record = await createLesson({
        doc: {
          ...nextDoc,
          title: t("labels.copyOf", {
            title: nextDoc.title || t("labels.untitledLesson"),
          }),
        },
        forkedFrom: id,
      });
      let cloned = false;
      try {
        const engine = await loadGitEngine();
        cloned = Boolean(await engine.forkLessonRepo(id, record.id));
      } catch {
        /* no history to clone — fall through to a fresh one */
      }
      adoptRecord(record);
      await refreshLocalLessons();
      notify({
        severity: "info",
        message: cloned
          ? t("messages.forkedWithHistory")
          : t("messages.forkedWithoutHistory"),
      });
      return;
    }

    // Editing a hub lesson we already have a copy of reopens that copy and takes
    // the hub's document — which is the authority, since it holds whatever was
    // saved from any other device — rather than starting a second copy of the
    // same lesson.
    const existing = (await listLessons()).find((l) => l.lessonId === id);
    let record;
    if (existing) {
      await saveLessonDoc(existing.id, nextDoc);
      await saveLessonMeta(existing.id, {
        lessonId: id,
        published,
        forkedFrom: incomingFork || null,
      });
      record = await getLesson(existing.id);
    } else {
      record = await createLesson({
        doc: nextDoc,
        lessonId: id,
        published,
        forkedFrom: incomingFork || null,
      });
    }
    adoptRecord(record);
    await refreshLocalLessons();
    notify({
      severity: "info",
      message: published
        ? t("messages.loadedPublished")
        : t("messages.loadedDraft"),
    });
  };

  // applyEdit closes over most of the editor's state, so its identity changes
  // every render. Mirror it in a ref so the mount-only effect below can call the
  // current one without listing it as a dependency (which would re-run the
  // one-shot load on every keystroke).
  const applyEditRef = useRef(applyEdit);
  useEffect(() => {
    applyEditRef.current = applyEdit;
  });

  // The hub asks us to edit one of the user's lessons — and the lesson page asks
  // us to fork any lesson — by stashing its id in sessionStorage (see
  // HubPage/LessonPage) and navigating here. Consume that request once on mount:
  // read and clear the key, fetch the full lesson, then either load it straight
  // away (when there's no in-progress work to lose) or ask before clobbering the
  // current draft. A one-shot ref guards against StrictMode's dev-only
  // double-mount; clearing the key also stops a reload from reloading it.
  useEffect(() => {
    // Wait until the saved draft has hydrated, so the "is there work to lose?"
    // check below sees the real document rather than the empty starter. Also
    // wait for the session to resolve: a private draft needs the access token
    // to load, and firing off the request token-less first would 404 on the
    // author's own draft before this effect's one-shot guard could retry.
    if (!hydrated || authLoading || editRequestedRef.current) return;
    let lessonId = null;
    let mode = "edit";
    try {
      lessonId = sessionStorage.getItem(EDIT_REQUEST_KEY);
      if (!lessonId) {
        lessonId = sessionStorage.getItem(FORK_REQUEST_KEY);
        mode = "fork";
      }
    } catch {
      /* sessionStorage unavailable — nothing to load */
    }
    if (!lessonId) return;
    editRequestedRef.current = true;
    try {
      sessionStorage.removeItem(EDIT_REQUEST_KEY);
      sessionStorage.removeItem(FORK_REQUEST_KEY);
    } catch {
      /* ignore */
    }

    setEditLoading(true);
    fetchLesson(lessonId, accessToken)
      .then((lesson) => {
        const incoming = {
          id: lesson.id,
          title: lesson.title,
          doc: lesson.doc,
          mode,
          // Drafts (published === false) load with their draft status preserved so
          // a re-save keeps them private until the author chooses to publish.
          published: lesson.published !== false,
          // Re-opening a lesson that is itself a fork keeps its link home, so the
          // "sync with the original" action stays available across sessions.
          forkedFrom: lesson.forkedFrom || null,
        };
        // Straight in. Nothing is at risk: an edit reopens the copy this device
        // already has of that lesson (or makes one), and a fork always becomes a
        // lesson of its own.
        applyEditRef.current(incoming);
      })
      .catch((err) => {
        notify({
          severity: "error",
          message:
            err.message ||
            t("messages.couldNotOpenLesson", {
              action:
                mode === "fork"
                  ? t("labels.forkingAction")
                  : t("labels.editingAction"),
            }),
        });
      })
      .finally(() => setEditLoading(false));
  }, [hydrated, authLoading, accessToken, notify, t]);

  const setTitle = (title) => setDoc((d) => ({ ...d, title }));

  // The age range the lesson is pitched at. Lives on the doc (so it persists
  // with the draft and travels with the lesson when published) and feeds the
  // AI lesson-idea suggester.
  const setAgeRange = (ageRange) => setDoc((d) => ({ ...d, ageRange }));

  // The per-document list of trusted collaborators. It lives on the doc itself
  // (not account-wide), so it persists with the draft and travels with the
  // lesson when published. Each entry is { email, name? }.
  const setTrustedCollaborators = (next) =>
    setDoc((d) => ({ ...d, trustedCollaborators: next }));

  // Holds a section still on screen while it's being reordered past its
  // (screenfuls-tall) neighbours — see moveSection.
  const anchorScroll = useScrollAnchor();

  const allCollapsed =
    doc.sections.length > 0 &&
    doc.sections.every((s) => collapsedIds.has(s.id));

  // Collapsing or expanding everything changes the page height by ~20x, so
  // whatever the user was looking at ends up somewhere arbitrary — or, when the
  // document suddenly gets shorter, clamped to the bottom. Pin the section they
  // were in to the top of the viewport instead, in both directions.
  const toggleAllCollapsed = () => {
    const el = currentSectionEl();
    setCollapsedIds(
      allCollapsed ? new Set() : new Set(doc.sections.map((s) => s.id)),
    );
    if (el) {
      requestAnimationFrame(() => scrollToElement(el, { smooth: false }));
    }
  };

  // Section callbacks are passed to memoized <SectionCard>s, so they must keep a
  // stable identity across renders — otherwise every keystroke would hand each
  // card new props and re-render the whole tree. They take an id (not an array
  // index) so the closure never goes stale, and use functional setDoc so they
  // never close over `doc`. `dir` is -1 (up) / +1 (down).
  const updateSection = useCallback(
    (id, next) =>
      setDoc((d) => ({
        ...d,
        sections: d.sections.map((s) => (s.id === id ? next : s)),
      })),
    [],
  );

  const deleteSection = useCallback(
    (id) =>
      setDoc((d) => ({
        ...d,
        sections: d.sections.filter((s) => s.id !== id),
      })),
    [],
  );

  const moveSection = useCallback(
    (id, dir) => {
      // Bounds-check before anchoring, the same order moveBlock uses: anchoring
      // arms a scroll correction that the *next* commit consumes, so doing it
      // ahead of a move that turns out to be a no-op leaves it primed to fire
      // against an unrelated later render. Read through docRef so this stays
      // dependency-free and every SectionCard keeps its memoized onMove.
      const sections = docRef.current.sections;
      const from = sections.findIndex((s) => s.id === id);
      const to = from + dir;
      if (from === -1 || to < 0 || to >= sections.length) return;
      // Ride with the section being moved. Sections are ~6 screens tall on a
      // desktop and ~9 on a phone, so reordering under a fixed scroll position
      // dumped the user into the middle of a *different* section and left the
      // button they'd just pressed thousands of pixels away.
      anchorScroll(idSelector("data-section-id", id));
      setDoc((d) => {
        // Re-derived inside the updater rather than reusing the array above:
        // the updater must be a pure function of `d`, which a concurrent edit
        // may have moved on from since docRef was read.
        const i = d.sections.findIndex((s) => s.id === id);
        const j = i + dir;
        if (i === -1 || j < 0 || j >= d.sections.length) return d;
        const next = [...d.sections];
        const [moved] = next.splice(i, 1);
        next.splice(j, 0, moved);
        return { ...d, sections: next };
      });
    },
    [anchorScroll],
  );

  const handleSectionError = useCallback(
    (message) => notify({ severity: "error", message }),
    [notify],
  );

  // Block drag-and-drop. The in-flight drag lives here, above the sections,
  // rather than inside a single <SectionCard> — that's what lets a block be
  // dragged out of one section and into another. A card reports which of its
  // blocks the insertion line should sit against; the drop then rewrites the doc.
  // Purely local UI state (never broadcast): only the resulting move is shared.
  const [drag, setDrag] = useState(null);
  // { blockId, fromSectionId, overSectionId, overId, overPos } | null
  const dragRef = useRef(null);
  // eslint-disable-next-line react-hooks/refs -- intentional mirror ref, read only in the stable drop handler
  dragRef.current = drag;

  // Hovering near the top or bottom of the window while dragging scrolls the
  // page, so a block can be carried to a section far off screen without the
  // mouse-jiggling the browser's own drag auto-scroll would need.
  useDragAutoScroll(drag !== null);

  const startBlockDrag = useCallback((sectionId, blockId) => {
    setDrag({
      blockId,
      fromSectionId: sectionId,
      overSectionId: null,
      overId: null,
      overPos: null,
    });
  }, []);

  // Where the block would land right now. Bails out when nothing actually moved,
  // so a drag that lingers over one spot doesn't re-render on every dragover.
  const hoverBlockDrag = useCallback((sectionId, overId, overPos) => {
    setDrag((d) => {
      if (!d) return d;
      if (
        d.overSectionId === sectionId &&
        d.overId === overId &&
        d.overPos === overPos
      )
        return d;
      return { ...d, overSectionId: sectionId, overId, overPos };
    });
  }, []);

  // The pointer left this section: drop the insertion line, since releasing
  // outside any section shouldn't move the block.
  const leaveBlockDrag = useCallback((sectionId) => {
    setDrag((d) =>
      d && d.overSectionId === sectionId
        ? { ...d, overSectionId: null, overId: null, overPos: null }
        : d,
    );
  }, []);

  const dropBlockDrag = useCallback(() => {
    const d = dragRef.current;
    setDrag(null);
    if (!d?.overSectionId) return;
    setDoc((doc) => applyBlockDrag(doc, d));
  }, []);

  const endBlockDrag = useCallback(() => setDrag(null), []);

  const openAddDialog = () => {
    setNewSectionName("");
    setDialogOpen(true);
  };

  // A new section is appended to the end of the document, which in a six-section
  // lesson is ~30,000px below wherever the user happens to be standing. The
  // dialog closed and, as far as the screen showed, nothing happened. Hold the
  // new id here and take the user to it once React has rendered it.
  const pendingSectionRef = useRef(null);

  useEffect(() => {
    const id = pendingSectionRef.current;
    if (!id) return;
    pendingSectionRef.current = null;
    const el = document.querySelector(idSelector("data-section-id", id));
    if (!el) return;
    scrollToElement(el);
    // The card's own name field, ready to be renamed. preventScroll because
    // focusing otherwise jumps the viewport there instantly and cancels the
    // smooth scroll that just started.
    el.querySelector("input")?.focus({ preventScroll: true });
  }, [doc.sections]);

  const confirmAddSection = () => {
    const name =
      newSectionName.trim() ||
      t("newSectionDialog.defaultName", { n: doc.sections.length + 1 });
    const id = newId();
    pendingSectionRef.current = id;
    setDoc((d) => ({
      ...d,
      sections: [...d.sections, { id, name, blocks: [] }],
    }));
    setDialogOpen(false);
  };

  const handleExport = async (kind) => {
    if (doc.sections.length === 0) {
      notify({
        severity: "warning",
        message: t("messages.addSectionBeforeExporting"),
      });
      return;
    }
    setBusy(kind);
    try {
      if (kind === "docx") {
        const { exportDocx } = await loadExportEngine();
        await exportDocx(doc);
        notify({ severity: "success", message: t("messages.wordDownloaded") });
      } else if (kind === "json") {
        exportJson(doc);
        notify({ severity: "success", message: t("messages.jsonDownloaded") });
      } else {
        const { exportPdf } = await loadExportEngine();
        await exportPdf(doc);
        notify({
          severity: "success",
          message: t("messages.pdfGenerated"),
        });
      }
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.exportFailed", { error: err.message || err }),
      });
    } finally {
      setBusy(null);
    }
  };

  const handleSaveToGoogle = async () => {
    if (doc.sections.length === 0) {
      notify({
        severity: "warning",
        message: t("messages.addSectionBeforeSaving"),
      });
      return;
    }
    setBusy("gdocs");
    try {
      const { saveToGoogleDrive } = await loadExportEngine();
      const file = await saveToGoogleDrive(doc);
      notify({
        severity: "success",
        message: t("messages.savedToGoogleDrive"),
        link: file.webViewLink
          ? { href: file.webViewLink, label: t("labels.open") }
          : null,
      });
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotSaveToGoogle", {
          error: err.message || err,
        }),
      });
    } finally {
      setBusy(null);
    }
  };

  // Preview renders the working doc with <LessonView> — the same component the
  // public lesson page uses. It is synchronous and free: no Word document is
  // built, so the preview neither waits for the export chunk nor differs from
  // what a reader will actually see once the lesson is published.
  const handlePreview = () => {
    if (doc.sections.length === 0) {
      notify({
        severity: "warning",
        message: t("messages.addSectionBeforePreviewing"),
      });
      return;
    }
    setPreviewOpen(true);
  };

  // Save the working lesson to the cloud. `publish` chooses whether it lands on the
  // public hub (true) or is backed up as a private draft (false). Either way, if a
  // lesson is already attached (editingId) we update that row; otherwise we create a
  // new one and enter edit mode for it, so a further save updates it instead of
  // creating a duplicate. The draft<->published state is recorded so the chip and
  // menu stay accurate.
  const handleSaveToCloud = async (publish) => {
    if (doc.sections.length === 0) {
      notify({
        severity: "warning",
        message: t("messages.addSectionBeforeSaving"),
      });
      return;
    }
    // Saving requires a signed-in account — send the user to the login page (and
    // back) if they aren't authenticated yet.
    if (!accessToken) {
      notify({
        severity: "info",
        message: t("messages.pleaseSignIn"),
      });
      navigate("/login");
      return;
    }
    setBusy("publish");
    try {
      // Convert any lingering legacy base64 images (e.g. from a fork or Word
      // import) to binary refs, then upload every referenced image to R2 before
      // writing the doc row — so the saved lesson never references a missing
      // object. A failed upload aborts here (caught below) and nothing is saved.
      const converted = await convertDocImages(doc);
      if (converted !== doc) setDoc(converted);
      await ensureImagesUploaded(converted, accessToken);

      // Updating a lesson that already exists: push the history FIRST.
      //
      // A lesson can now have two writers — its author, and a trusted
      // collaborator merging a fork back in — so the hub's copy may hold commits
      // we've never seen. Pushing tells us: if the lesson has moved on, the push
      // is refused and we stop here, *before* overwriting the doc row with a
      // document that doesn't contain their work. The user merges (below) and
      // saves again.
      if (editingId && hasApi()) {
        await git.commitNow();
        const engine = await loadGitEngine();
        const result = await engine.pushHistory({
          repoId: editingId,
          lessonId: editingId,
          doc: converted,
          accessToken,
        });

        if (result.needsMerge && result.prepared) {
          setMergeIntent("publish");
          setMerge(result.prepared);
          notify({
            severity: "info",
            message: t("messages.needsMergeBeforeSave"),
          });
          return;
        }
      }

      let lessonId = editingId;
      if (editingId) {
        await updateLesson(editingId, converted, accessToken, {
          published: publish,
        });
      } else {
        const lesson = await publishLesson(converted, accessToken, {
          published: publish,
          // Record what this lesson was forked from, so it can pull the
          // original's later changes in (see handleSyncUpstream).
          forkedFrom,
        });
        if (lesson?.id) {
          lessonId = lesson.id;
          // Move the draft's repository under the new lesson's id *before*
          // switching to it, so the history built up while the lesson was an
          // unsaved draft comes with it rather than being stranded. adoptDraft
          // commits any outstanding edits into the draft before copying it.
          await git.adoptDraft(lesson.id);
          setEditingId(lesson.id);
        }
      }
      setEditingPublished(publish);

      // A brand-new lesson has no history on the hub yet, so this is its first
      // push. Deliberately non-fatal: the lesson itself is safely stored either
      // way, and the next save will carry the history up.
      let historyWarning = null;
      if (!editingId && lessonId && hasApi()) {
        try {
          const engine = await loadGitEngine();
          await engine.pushHistory({
            repoId: lessonId,
            lessonId,
            doc: converted,
            accessToken,
          });
        } catch (err) {
          console.error(err);
          historyWarning = err.message || t("messages.historyNotSaved");
        }
      }

      notify({
        severity: historyWarning ? "warning" : "success",
        message: historyWarning
          ? t("messages.savedWithHistoryWarning", { warning: historyWarning })
          : publish
            ? t("messages.publishedToHub")
            : t("messages.draftSaved"),
        route:
          publish && !historyWarning
            ? { to: "/hub", label: t("labels.viewHub") }
            : undefined,
      });
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotSave", { error: err.message || err }),
      });
    } finally {
      setBusy(null);
    }
  };

  // Fork the lesson being edited into a new one, and continue in the fork — so
  // the next "Publish" creates a separate lesson instead of updating the one
  // this came from.
  //
  // The lesson it came from doesn't go anywhere: it stays in this device's
  // library, still attached to its hub row, and is one click away in the lessons
  // panel. (Before the library there was only one working document, so forking
  // had to *detach* that document, and the original was gone from the editor
  // until you fetched it again.)
  //
  // Like forking from the hub, this clones the repository rather than just
  // copying the text: the fork keeps the history and shares ancestry with the
  // lesson it left, so the two can be merged later.
  const handleFork = async () => {
    const from = editingId;
    await flushCurrentLesson();

    const record = await createLesson({
      doc: {
        ...doc,
        title: t("labels.copyOf", {
          title: doc.title || t("labels.untitledLesson"),
        }),
      },
      forkedFrom: from || null,
    });
    try {
      const engine = await loadGitEngine();
      await engine.forkLocalRepo(repoIdFor(from, localId), record.id);
    } catch {
      /* no local history to carry over — the fork starts a fresh one */
    }
    adoptRecord(record);
    await refreshLocalLessons();
    notify({
      severity: "info",
      message: t("messages.forkedNoUpstream"),
    });
  };

  // Pull the original lesson's changes into this fork.
  //
  // The merge is by block id, against the commit the two histories diverged from:
  // a block only one side changed is taken from that side, and a block both sides
  // changed in *different fields* is merged so both edits survive. Only a genuine
  // clash — the same field of the same block, given two different values — is put
  // to the user, in MergeDialog.
  const handleSyncUpstream = async () => {
    if (!forkedFrom) return;
    setBusy("merge");
    try {
      // Commit what's outstanding first: the merge is computed against the doc on
      // screen, and its result becomes a commit with two parents, so our side of
      // it needs to actually be in the history.
      await git.commitNow();

      const engine = await loadGitEngine();
      const prepared = await engine.prepareMerge({
        repoId: git.repoId,
        lessonId: forkedFrom,
        doc,
        ref: engine.UPSTREAM_REF,
      });

      if (!prepared) {
        notify({
          severity: "info",
          message: t("messages.noSharedHistoryToMerge"),
        });
        return;
      }
      if (prepared.upToDate) {
        notify({
          severity: "success",
          message: t("messages.alreadyUpToDate"),
        });
        return;
      }

      setMergeIntent("pull");
      setMerge(prepared);
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotMerge", { error: err.message || err }),
      });
    } finally {
      setBusy(null);
    }
  };

  // A variation name for trying a proposal out: the title, so a reviewer knows
  // which one it is, and the proposal's first few characters, so they know *which
  // proposal*.
  //
  // The suffix isn't decoration. Without it two proposals whose titles normalise
  // the same share a variation, and trying the second lands it on top of the
  // first — one branch holding two people's changes, presented as one. It also
  // makes the name stable, so re-trying a proposal returns to the variation it
  // made last time rather than to somebody else's.
  const variationNameFor = (title, id) => {
    const short = id.replace(/-/g, "").slice(0, 6);
    return (
      toBranchName(`${title} ${short}`) || toBranchName(`Proposal ${short}`)
    );
  };

  // Undo one change from the history, keeping everything since it.
  //
  // Restoring puts the whole lesson back and drops what came after; this puts back
  // only what that one version changed. Where the two overlap — the change has
  // been built on since — there is a genuine decision to make, and it goes to the
  // usual conflict dialog rather than being guessed at.
  // What to call the other side of a merge, per intent.
  //
  // One function rather than the two parallel ternary chains this used to be —
  // the merge dialog's title and the commit message have to agree, and a new
  // intent added to one chain and not the other is exactly how they stopped.
  // `dialog` differs only where a generic name reads better than an empty one.
  const theirNameFor = (intent, { dialog = false } = {}) => {
    switch (intent) {
      case "publish":
        return dialog ? t("labels.theSavedLesson") : doc.title;
      case "pull-request":
        return reviewPull?.title || t("labels.theProposal");
      case "pull-request-try":
        return mergeProposalTitle || t("labels.theProposal");
      case "variation":
        return branchLabel(mergeVariation || "");
      case "undo":
        return merge?.summary || "";
      default:
        return dialog
          ? forkedFromTitle || t("labels.theOriginal")
          : forkedFromTitle;
    }
  };

  const handleUndoCommit = async (oid) => {
    setBusy("merge");
    try {
      await git.commitNow();

      const engine = await loadGitEngine();
      const prepared = await engine.prepareRevert({
        repoId: git.repoId,
        oid,
        doc,
      });

      // Nothing of that change is still standing: it has already been undone, or
      // everything it touched has since been changed again. Say so rather than
      // opening a dialog that would commit nothing.
      if (
        prepared.conflicts.length === 0 &&
        diffDocs(doc, prepared.doc).length === 0
      ) {
        notify({ severity: "info", message: t("messages.nothingToUndo") });
        return;
      }

      setMergeIntent("undo");
      setMerge(prepared);
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotUndo", { error: err.message || err }),
      });
    } finally {
      setBusy(null);
    }
  };

  // Bring a variation into the main lesson.
  //
  // The order is the whole of it. We switch to the main lesson *first*, so the
  // merge commits there and the document that comes back is the lesson with the
  // variation folded in — not the variation with the lesson folded in, which is
  // the same commit and the opposite meaning. Switching commits anything
  // outstanding to the variation on its way out, so nothing in flight is lost.
  const handleBringVariationIn = async (name) => {
    setBusy("merge");
    try {
      // Merging commits to whatever is checked out, so this has to have taken
      // before anything is prepared — otherwise the lesson gets folded into the
      // variation, which is the same commit and the opposite meaning. A failure
      // throws and is caught below; a null document means the lesson has no
      // commits at all, and there is nothing to merge into.
      const onMain = await git.switchBranch(engineDefaultBranch);
      if (!onMain) {
        notify({ severity: "info", message: t("messages.nothingToMergeInto") });
        return;
      }
      setDoc(onMain);

      const engine = await loadGitEngine();
      const prepared = await engine.prepareBranchMerge({
        repoId: git.repoId,
        name,
        doc: onMain,
      });

      // Already in: every commit the variation has is in the lesson's history, so
      // there is nothing to fold in.
      if (!prepared || prepared.upToDate) {
        notify({
          severity: "info",
          message: t("messages.variationAlreadyIn", {
            name: branchLabel(name),
          }),
        });
        return;
      }

      setMergeIntent("variation");
      setMergeVariation(name);
      setMerge(prepared);
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotMerge", { error: err.message || err }),
      });
    } finally {
      setBusy(null);
    }
  };

  // Offer this fork's work back to the lesson it came from — as a proposal, not
  // a write.
  //
  // Nothing in the original changes here. What we send is a snapshot of this
  // lesson's repository, which the original's author (or one of the trusted
  // collaborators they named) reviews and merges from their own editor. That
  // review step is deliberate: a fork can no longer push itself into someone
  // else's published lesson, however trusted its owner is.
  // The proposal this fork already has open against the lesson it came from, if
  // there is one.
  //
  // Without this, being asked for a change and making it meant opening a *second*
  // proposal, leaving the reviewer two overlapping ones and the conversation on
  // the wrong one. With it, the button says "update" and does.
  //
  // Scoped to proposals from *this* fork (`sourceLessonId`), not merely ones by
  // this person: proposing to the same lesson from two different forks is a
  // legitimate thing to do, and they are not updates of each other.
  const [openProposal, setOpenProposal] = useState(null);

  // Bumped on every lookup, so a slow response for a lesson we have since left
  // can't win. Without it, switching lessons while a request is in flight can
  // leave `openProposal` holding one that belongs to a different fork — and the
  // update button would then push this work to that proposal's id.
  const proposalLookup = useRef(0);

  const refreshOpenProposal = useCallback(async () => {
    const attempt = ++proposalLookup.current;
    const current = () => proposalLookup.current === attempt;

    if (!forkedFrom || !editingId || !user?.id || !hasApi()) {
      setOpenProposal(null);
      return null;
    }
    try {
      const { pulls } = await fetchPullRequests(forkedFrom, accessToken);
      const mine =
        pulls.find(
          (p) =>
            p.status === "open" &&
            p.ready &&
            p.authorId === user.id &&
            p.sourceLessonId === editingId,
        ) || null;
      if (!current()) return null;
      setOpenProposal(mine);
      return mine;
    } catch {
      // A queue we couldn't read just means the button keeps its "propose"
      // wording; opening a second proposal is recoverable, and failing the
      // editor over it would not be.
      return null;
    }
  }, [forkedFrom, editingId, user?.id, accessToken]);

  useEffect(() => {
    refreshOpenProposal();
  }, [refreshOpenProposal]);

  // Replace what an already-open proposal contains with the work as it stands.
  // No dialog: its title and note are already written and this endpoint doesn't
  // change them, so there is nothing to ask.
  const handleUpdateProposal = async () => {
    if (!openProposal) return;
    setProposing(true);
    try {
      await git.commitNow();

      const engine = await loadGitEngine();
      const updated = await engine.updatePullRequest({
        repoId: git.repoId,
        lessonId: forkedFrom,
        pullId: openProposal.id,
        head: openProposal.head,
        accessToken,
      });
      setOpenProposal(updated || openProposal);

      notify({
        severity: "success",
        message: t("messages.proposalUpdated", { title: openProposal.title }),
        route: {
          to: `/hub/${forkedFrom}/proposals/${openProposal.id}`,
          label: t("labels.viewProposal"),
        },
      });
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotPropose", { error: err.message || err }),
      });
    } finally {
      setProposing(false);
    }
  };

  const handleProposeChanges = async ({ title, body }) => {
    if (!forkedFrom) return;
    setProposing(true);
    try {
      // Commit what's outstanding first: the proposal is the committed history,
      // so anything still only in the editor would simply not be in it.
      await git.commitNow();

      const engine = await loadGitEngine();
      await engine.submitPullRequest({
        repoId: git.repoId,
        lessonId: forkedFrom,
        title,
        body,
        // Recorded (and verified server-side) only when this fork is itself a
        // saved lesson, so a reviewer can see the proposal in its full context.
        sourceLessonId: editingId,
        accessToken,
      });

      setProposeOpen(false);
      refreshOpenProposal();
      notify({
        severity: "success",
        message: t("messages.proposalOpened", {
          name: forkedFromTitle || t("labels.theOriginalLesson"),
        }),
        route: { to: `/hub/${forkedFrom}`, label: t("labels.viewLesson") },
      });
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotPropose", { error: err.message || err }),
      });
    } finally {
      setProposing(false);
    }
  };

  // Review a proposal against the lesson currently open for editing — the other
  // side of the flow above, reached from the lesson page's proposals list, which
  // sends us here with ?pull=<id>.
  //
  // The proposal's history is indexed into this lesson's own repository, where it
  // meets the commits the two already share, and merged block by block against
  // the commit they diverged from. Only genuine clashes reach the dialog; the
  // merge is landed by finishPullMerge once they're settled.
  const reviewPullRequest = async (pullId, { intoVariation = false } = {}) => {
    if (!editingId) return;
    setBusy("review");
    try {
      await git.commitNow();

      // The list is where a proposal's title and author live, and it's also how
      // we find out whether it is still open at all.
      const { pulls } = await fetchPullRequests(editingId, accessToken);
      const pull = pulls.find((p) => p.id === pullId);
      if (!pull) {
        notify({ severity: "error", message: t("messages.proposalGone") });
        return;
      }
      if (pull.status !== "open") {
        notify({ severity: "info", message: t("messages.proposalResolved") });
        return;
      }

      // Trying it out first: land the proposal on a variation instead of the
      // lesson, so the reviewer can read it in place — click through it, run it,
      // show it to somebody — before deciding. The merge below then targets that
      // variation, because a merge commits to whatever branch is checked out.
      //
      // Nothing about the proposal changes. It stays open, and landing it for
      // real is still a separate act on the main lesson; this only means the
      // reviewer no longer has to choose between merging blind and not merging.
      // The merge is computed against a document, and after a branch switch that
      // must be the document on the branch being switched *to*. `doc` is this
      // render's value and setDoc doesn't change it, so the switched-to document
      // is threaded through explicitly — the same shape handleBringVariationIn
      // uses, and for the same reason.
      let mergeDoc = doc;

      if (intoVariation) {
        const name = variationNameFor(pull.title, pull.id);
        // Trying the same proposal twice should land back where the first attempt
        // put it, not fail on the name being taken. Switching also picks up
        // whatever the reviewer did to it last time, which is the point of having
        // kept it.
        const existing = git.branches.some((b) => b.name === name);
        if (existing) {
          const next = await git.switchBranch(name);
          if (next) {
            setDoc(next);
            mergeDoc = next;
          }
        } else {
          // A new variation starts at the commit we are already on, so the
          // document doesn't move and `doc` is still the right one.
          await git.createVariation(name);
        }
        notify({
          severity: "info",
          message: t(
            existing
              ? "messages.tryingInExistingVariation"
              : "messages.tryingInVariation",
            { name: branchLabel(name) },
          ),
        });
      }

      const engine = await loadGitEngine();
      const prepared = await engine.preparePullMerge({
        repoId: git.repoId,
        lessonId: editingId,
        pullId,
        doc: mergeDoc,
        accessToken,
      });
      if (!prepared) {
        notify({ severity: "error", message: t("messages.proposalGone") });
        return;
      }

      // Only a review that is going to *land* the proposal records it as the one
      // being reviewed — that is what confirmMerge reads to push and mark it
      // merged. A try-out must not: the proposal stays open, waiting for a real
      // decision on the lesson itself.
      if (!intoVariation) setReviewPull(pull);

      // We already contain everything it proposes (it was merged some other way,
      // or it never diverged): there is nothing to settle, so land it as it is.
      if (prepared.upToDate) {
        if (intoVariation) {
          notify({
            severity: "info",
            message: t("messages.proposalAlreadyIn"),
          });
          return;
        }
        await finishPullMerge(pull, mergeDoc);
        return;
      }

      setMergeProposalTitle(pull.title || "");
      setMergeIntent(intoVariation ? "pull-request-try" : "pull-request");
      setMerge(prepared);
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotReviewProposal", {
          error: err.message || err,
        }),
      });
    } finally {
      setBusy(null);
    }
  };

  // Land a reviewed proposal: push the merged history, save the lesson's
  // document, then record the merge — strictly in that order.
  //
  // The Worker refuses to mark a proposal merged unless the merge commit really
  // is what the lesson's stored history points at, so this order isn't a
  // convention, it's the only one that works. If the lesson has moved on beneath
  // us in the meantime the push is refused rather than overwriting it, and the
  // proposal simply stays open while that's merged first.
  const finishPullMerge = async (pull, mergedDoc) => {
    const engine = await loadGitEngine();

    const result = await engine.pushHistory({
      repoId: git.repoId,
      lessonId: editingId,
      doc: mergedDoc,
      accessToken,
    });
    if (result.needsMerge) {
      setMergeIntent("publish");
      setMerge(result.prepared);
      notify({
        severity: "warning",
        message: t("messages.needsMergeBeforeSave"),
      });
      return;
    }

    await updateLesson(editingId, mergedDoc, accessToken);

    const head = await engine.headOid(engine.repoCtx(git.repoId));
    await mergePullRequest(editingId, pull.id, head, accessToken);
    setReviewPull(null);

    notify({
      severity: "success",
      message: t("messages.proposalMerged", { title: pull.title }),
      route: { to: `/hub/${editingId}`, label: t("labels.viewLesson") },
    });
  };

  const confirmMerge = async (choices) => {
    if (!merge) return;
    setMerging(true);
    try {
      const engine = await loadGitEngine();
      const merged = await engine.completeMerge({
        repoId: git.repoId,
        prepared: merge,
        choices,
        author: identity,
        theirName: theirNameFor(mergeIntent),
        currentDoc: doc,
      });
      setDoc(merged);
      const intent = mergeIntent;
      const variation = mergeVariation;
      setMerge(null);
      setMergeVariation(null);
      setMergeProposalTitle("");

      if (intent === "undo") {
        notify({ severity: "success", message: t("messages.undone") });
        git.refreshBranches();
        return;
      }

      if (intent === "variation") {
        notify({
          severity: "success",
          message: t("messages.variationBroughtIn", {
            name: branchLabel(variation || ""),
          }),
        });
        git.refreshBranches();
        return;
      }
      if (intent === "pull-request-try") {
        notify({
          severity: "success",
          message: t("messages.proposalInVariation", {
            name: branchLabel(git.branch),
          }),
        });
        git.refreshBranches();
        return;
      }
      if (intent === "pull-request") {
        if (reviewPull) await finishPullMerge(reviewPull, merged);
        // A fast-forward leaves no new commit, so the version chip has to be
        // told the branch moved.
        git.refreshBranches();
        return;
      }
      if (intent === "publish") {
        // This was a proposal whose push found the lesson had moved on. Now that
        // we contain what it moved to, the push will go through — so carry on
        // landing it rather than making the reviewer start the review again.
        if (reviewPull) {
          await finishPullMerge(reviewPull, merged);
          return;
        }
        // The merge is committed locally; the save that triggered it was aborted
        // before it could overwrite anything, so the user re-runs it.
        notify({
          severity: "success",
          message: t("messages.mergedFromHubPublish"),
        });
        return;
      }
      notify({
        severity: "success",
        message: t("messages.mergedFrom", {
          name: forkedFromTitle || t("labels.theOriginal"),
        }),
      });
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotCompleteMerge", {
          error: err.message || err,
        }),
      });
    } finally {
      setMerging(false);
    }
  };

  // Arriving to review a proposal: the lesson page's proposals list sends us here
  // as /editor?pull=<id>&lesson=<lessonId>, having also asked the editor to load
  // that lesson.
  //
  // We can't act the moment we land, and "some lesson is open" isn't good enough
  // either. The reviewer may already have had a *different* lesson open, whose id
  // is restored from storage and whose repository goes ready long before the
  // requested one has been fetched — or confirmed, if there was in-progress work
  // to replace. Reviewing against that lesson would look for a proposal that
  // isn't on it and report it missing, and the one-shot guard below would stop us
  // trying again once the right lesson arrived. So we wait for the lesson the
  // link actually named.
  //
  // Reading the handler through a ref keeps the effect from re-firing every time
  // the doc changes underneath it.
  const pullParam = searchParams.get("pull") || "";
  const pullLessonParam = searchParams.get("lesson") || "";
  // ?try=1 — land it on a variation to look at rather than on the lesson.
  const pullTryParam = searchParams.get("try") === "1";
  const reviewPullRef = useRef(reviewPullRequest);
  const pullHandledRef = useRef("");
  useEffect(() => {
    reviewPullRef.current = reviewPullRequest;
  });
  useEffect(() => {
    if (!pullParam || !pullLessonParam || !git.ready || !accessToken) return;
    if (editingId !== pullLessonParam) return;
    if (pullHandledRef.current === pullParam) return;
    pullHandledRef.current = pullParam;
    reviewPullRef.current(pullParam, { intoVariation: pullTryParam });
  }, [
    pullParam,
    pullLessonParam,
    pullTryParam,
    editingId,
    git.ready,
    accessToken,
  ]);

  // Word import. We warn first (the conversion is lossy and can fail), then open
  // the file picker; the chosen file is parsed and validated by importDocxFile,
  // which rejects documents that aren't structured as a lesson — those are
  // refused with an explanatory dialog and never loaded into the editor.
  const openImportWarning = () => {
    setImportWarnOpen(true);
  };

  const triggerImportPicker = () => {
    setImportWarnOpen(false);
    importInputRef.current?.click();
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = "";
    if (!file) return;
    setBusy("import");
    try {
      const { importDocxFile } = await loadExportEngine();
      const imported = await importDocxFile(file);
      // Straight in — the import opens as a new lesson beside the one you were
      // working on, rather than in place of it.
      await applyEdit({
        doc: imported,
        title: imported.title,
        mode: "import",
        source: "word",
      });
    } catch (err) {
      setImportErrorSource("word");
      setImportError(err?.message || t("messages.wordImportFailed"));
    } finally {
      setBusy(null);
    }
  };

  // JSON import. No lossy warning (the format is our own), so the picker opens
  // straight away; a chosen file is parsed and validated by importJsonFile,
  // which rejects anything that isn't a lesson — surfaced in the same dialog.
  const triggerJsonImportPicker = () => {
    jsonInputRef.current?.click();
  };

  const handleImportJsonFile = async (e) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = "";
    if (!file) return;
    setBusy("import");
    try {
      const imported = await importJsonFile(file);
      await applyEdit({
        doc: imported,
        title: imported.title,
        mode: "import",
        source: "json",
      });
    } catch (err) {
      setImportErrorSource("json");
      setImportError(err?.message || t("messages.jsonImportFailed"));
    } finally {
      setBusy(null);
    }
  };

  const sectionCount = doc.sections.length;
  const blockCount = useMemo(
    () => doc.sections.reduce((sum, s) => sum + s.blocks.length, 0),
    [doc.sections],
  );

  // Every capitalized word across the lesson's text blocks. Feeds the spelling
  // block's "fill" button, so it can populate the list from the passage. The
  // scan is O(whole lesson), so defer it: it runs at low priority on a snapshot
  // that lags `doc`, instead of blocking the keystroke that triggered the edit.
  // The scan result would be a fresh array on every edit, and a new array each
  // keystroke would bust the memoized cards (capitalizedWords is passed to all
  // of them). Keep the previous array when its contents are unchanged, so the
  // reference only changes when the word set actually does.
  const capWordsRef = useRef([]);
  const capitalizedWords = useMemo(() => {
    const next = extractCapitalizedWords(doc);
    const prev = capWordsRef.current;
    // eslint-disable-next-line react-hooks/refs -- intentional referential-stability cache of the previous result
    if (prev.length === next.length && prev.every((w, i) => w === next[i])) {
      return prev;
    }
    // eslint-disable-next-line react-hooks/refs -- intentional referential-stability cache of the previous result
    capWordsRef.current = next;
    return next;
  }, [doc]);

  // "Save to cloud" menu labels adapt to whether a lesson is already attached
  // (editingId) and, if so, whether it's currently published or a draft — so each
  // action reads as either creating, updating, or switching the lesson's state.
  const publishActionLabel =
    editingId && editingPublished
      ? t("labels.updatePublishedLesson")
      : t("labels.publishToHub");
  const draftActionLabel =
    editingId && !editingPublished
      ? t("labels.updateDraft")
      : t("labels.saveAsDraft");

  const exportBusy =
    busy === "docx" || busy === "json" || busy === "pdf" || busy === "gdocs";

  // Header icon-only triggers (help, the import menu, the mobile overflow
  // menu). These used to be drawn from --primary-foreground because the app bar
  // was a block of --primary; PageBar sits on the page background, so they take
  // the ordinary tokens now. bg-transparent and border-0 stay explicit so a
  // <button> doesn't pick up the browser's default chrome.
  const headerIconTrigger =
    "relative inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-foreground no-underline transition-colors hover:bg-accent hover:text-accent-foreground";
  const headerGhostButton = "";

  // The small "N collaborators online" dot, overlaid on whichever trigger
  // shows it (the mobile overflow menu, the desktop Collaborate button).
  const collabCount = collab.active ? collab.participants.length : 0;
  const CollabDot = collabCount > 0 && (
    <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-success text-[10px] font-medium text-success-foreground">
      {collabCount}
    </span>
  );

  return (
    <>
      {/* No page-specific title: the editor is the app default. */}
      <DocumentMeta />
      {/* The trail names the lesson being edited, not "Editor" — on the one
          page where you're deep inside a single document, which document it is
          is the useful fact. */}
      <PageBar
        crumbs={[
          { label: t("header.title"), to: "/hub" },
          { label: doc.title || t("documentPanel.untitledCrumb") },
        ]}
      >
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("header.menuAriaLabel")}
                  className={headerIconTrigger}
                >
                  <SpellCheckIcon />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("header.menuTooltip")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={openImportWarning}
              disabled={busy !== null}
            >
              <FileUpIcon />
              {t("header.importWord")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={triggerJsonImportPicker}
              disabled={busy !== null}
            >
              <BracesIcon />
              {t("header.importJson")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                window.open(
                  "https://github.com/playforge-coding/spelling-creator",
                  "_blank",
                )
              }
            >
              <CodeIcon />
              {t("header.github")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Mobile: help + one overflow menu covering every other action. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={openWizard}
              aria-label={t("header.helpAriaLabel")}
              className={cn(headerIconTrigger, "md:hidden")}
            >
              <CircleHelpIcon />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("header.helpTooltip")}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("header.actionsAriaLabel")}
                  className={cn(headerIconTrigger, "md:hidden")}
                >
                  <EllipsisVerticalIcon />
                  {CollabDot}
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("header.actionsTooltip")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => openPanel("lessons")}>
              <LibraryIcon />
              {t("header.lessons")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handlePreview} disabled={busy !== null}>
              <EyeIcon />
              {t("header.preview")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={openImportWarning}
              disabled={busy !== null}
            >
              <FileUpIcon />
              {t("header.importWord")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={triggerJsonImportPicker}
              disabled={busy !== null}
            >
              <BracesIcon />
              {t("header.importJson")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => handleExport("docx")}
              disabled={busy !== null}
            >
              <FileTextIcon />
              {t("header.exportDocx")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport("json")}
              disabled={busy !== null}
            >
              <BracesIcon />
              {t("header.exportJson")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport("pdf")}
              disabled={busy !== null}
            >
              <PrinterIcon />
              {t("header.printPdf")}
            </DropdownMenuItem>
            {hasGoogleDrive() && (
              <DropdownMenuItem
                onClick={handleSaveToGoogle}
                disabled={busy !== null}
              >
                <SaveIcon />
                {t("header.saveToGoogleDocs")}
              </DropdownMenuItem>
            )}
            {showPublish && <DropdownMenuSeparator />}
            {showPublish && (
              <DropdownMenuItem
                onClick={() => handleSaveToCloud(true)}
                disabled={busy !== null}
              >
                <CloudUploadIcon />
                {publishActionLabel}
              </DropdownMenuItem>
            )}
            {showPublish && (
              <DropdownMenuItem
                onClick={() => handleSaveToCloud(false)}
                disabled={busy !== null}
              >
                <CloudIcon />
                {draftActionLabel}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openPanel("collaborate")}>
              <UsersIcon />
              {collab.active
                ? t("header.collaborating", {
                    count: collab.participants.length,
                  })
                : t("header.collaborate")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Desktop: the actions as their own buttons. */}
        <div className="hidden items-center gap-1 md:flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={openWizard}
                aria-label={t("header.helpAriaLabel")}
                className={headerIconTrigger}
              >
                <CircleHelpIcon />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("header.helpTooltip")}</TooltipContent>
          </Tooltip>
          {/* The way back to everything else this device is holding. It sits
              with the actions rather than in the document panel because it is
              about which lesson you're in, not about the one you're in. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                onClick={() => openPanel("lessons")}
                className={headerGhostButton}
              >
                <LibraryIcon data-icon="inline-start" />
                {t("header.lessons")}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {t("header.lessonsTooltip")}
            </TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            onClick={handlePreview}
            disabled={busy !== null}
            className={headerGhostButton}
          >
            <EyeIcon data-icon="inline-start" />
            {t("header.preview")}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                disabled={busy !== null}
                className={headerGhostButton}
              >
                {exportBusy ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                {t("header.export")}
                <ChevronDownIcon className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExport("docx")}>
                <FileTextIcon />
                {t("header.exportDocx")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("json")}>
                <BracesIcon />
                <div className="flex flex-col">
                  <span>{t("header.exportJson")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("header.exportJsonHint")}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("pdf")}>
                <PrinterIcon />
                {t("header.printPdf")}
              </DropdownMenuItem>
              {hasGoogleDrive() && (
                <DropdownMenuItem onClick={handleSaveToGoogle}>
                  <SaveIcon />
                  {t("header.saveToGoogleDocs")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {showPublish && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  className={headerGhostButton}
                >
                  {busy === "publish" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <CloudIcon data-icon="inline-start" />
                  )}
                  {t("header.saveToCloud")}
                  <ChevronDownIcon className="opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleSaveToCloud(true)}>
                  <CloudUploadIcon />
                  <div className="flex flex-col">
                    <span>{publishActionLabel}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("header.publishHint")}
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleSaveToCloud(false)}>
                  <CloudIcon />
                  <div className="flex flex-col">
                    <span>{draftActionLabel}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("header.draftHint")}
                    </span>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="relative inline-flex">
                <Button
                  variant={collab.active ? "default" : "ghost"}
                  onClick={() => openPanel("collaborate")}
                  className={collab.active ? undefined : headerGhostButton}
                >
                  <UsersIcon data-icon="inline-start" />
                  {t("header.collaborate")}
                </Button>
                {CollabDot}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t("header.collaborateTooltip")}</TooltipContent>
          </Tooltip>
        </div>
      </PageBar>

      {/* Three panes: the section outline, the document, and a live preview.
          Each appears once there is room for it, and drops away when there
          isn't — the panes are extra room to spend, not a layout the editor
          depends on.
          
          "Room" is measured against AppShell's @container/page, not the
          viewport, and that distinction is what lets the editor use the same
          sidebar as every other page. The sidebar is 16rem open and 3rem
          collapsed, so the space the editor actually has is not a function of
          the window's width; keyed off the container, collapsing the sidebar
          hands the panes its 13rem the instant you do it. The editor used to
          get its own permanently-collapsed sidebar to dodge this, which bought
          the room at the price of the app having two different sidebars.

          `items-start` so each pane scrolls with the page and the sticky
          columns inside them can pin. */}
      <div className="mx-auto flex w-full max-w-[110rem] items-start gap-6 px-4 pt-6 pb-16">
        <SectionOutline
          sections={doc.sections}
          collapsedIds={collapsedIds}
          allCollapsed={allCollapsed}
          onToggleAll={toggleAllCollapsed}
          onAddSection={openAddDialog}
        />

        {/* min-w-0 is load-bearing: without it this flex item is sized by its
            widest child, and one long unbroken word in a lesson would push the
            preview pane off screen instead of wrapping. */}
        <div className="mx-auto min-w-0 max-w-3xl flex-1 @min-[52rem]/page:mx-0">
          <div className="rounded-panel border border-border bg-card p-4 text-card-foreground shadow-(--shadow-panel) sm:p-6">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t("documentPanel.titleLabel")}
            </p>
            <LiveInput
              value={doc.title}
              onCommit={setTitle}
              placeholder={t("documentPanel.titlePlaceholder")}
              data-collab-field="doc:title"
              className="h-auto rounded-none border-0 border-b-2 border-transparent bg-transparent px-0 py-1 text-2xl font-bold shadow-none focus-visible:border-b-primary focus-visible:ring-0"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Select
                value={doc.ageRange || "any"}
                onValueChange={(v) => setAgeRange(v === "any" ? "" : v)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-[160px]"
                  aria-label={t("documentPanel.ageRangeAriaLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">
                    {t("documentPanel.anyAge")}
                  </SelectItem>
                  {AGE_RANGES.map((range) => (
                    <SelectItem key={range} value={range}>
                      {range}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setIdeaDialogOpen(true)}
                  >
                    <SparklesIcon data-icon="inline-start" />
                    {t("documentPanel.suggestIdeas")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("documentPanel.suggestIdeasTooltip")}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-sm text-muted-foreground">
                {t("stats.summary", {
                  sections: t("stats.sections", { count: sectionCount }),
                  blocks: t("stats.blocks", { count: blockCount }),
                })}
              </p>
              {/* Folding every section away turns a ~37-screen document into a
                two-screen list of its sections — the fastest way to see the
                shape of a lesson, and to get to a section a long way from the
                one you're in. */}
              {sectionCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleAllCollapsed}
                  className="h-10 sm:h-8"
                >
                  {allCollapsed ? (
                    <ChevronsUpDownIcon data-icon="inline-start" />
                  ) : (
                    <ChevronsDownUpIcon data-icon="inline-start" />
                  )}
                  {allCollapsed
                    ? t("documentPanel.expandAll")
                    : t("documentPanel.collapseAll")}
                </Button>
              )}
            </div>

            {(editingId || git.ready) && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {editingId && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className={cn(
                          "gap-1",
                          editingPublished
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border bg-transparent text-muted-foreground",
                        )}
                      >
                        {editingPublished ? <CloudUploadIcon /> : <CloudIcon />}
                        {editingPublished
                          ? t("documentPanel.editingPublished")
                          : t("documentPanel.editingDraft")}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {editingPublished
                        ? t("documentPanel.editingPublishedTooltip")
                        : t("documentPanel.editingDraftTooltip")}
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Version history. Every edit is committed to the lesson's own git
                  repository when you pause; this is the way in to that timeline. */}
                {git.ready && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => openPanel("history")}
                        className="cursor-pointer border-0 bg-transparent p-0"
                      >
                        <Badge
                          variant="outline"
                          className={cn(
                            "gap-1",
                            git.pending > 0
                              ? "border-border bg-transparent text-muted-foreground"
                              : "border-success/40 bg-success/10 text-success",
                          )}
                        >
                          <HistoryIcon />
                          {git.pending > 0
                            ? t("history.unsavedChanges", {
                                count: git.pending,
                              })
                            : git.lastCommit
                              ? t("history.versionSaved", {
                                  time: timeAgo(git.lastCommit.at),
                                })
                              : t("history.label")}
                        </Badge>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {t("history.tooltip")}
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Which copy of the lesson is being edited. On the main lesson
                    this is a quiet chip that mostly exists to say the feature is
                    there; on a variation it is the reminder that what you change
                    isn't what people are reading. */}
                {git.ready && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => openPanel("variations")}
                        className="cursor-pointer border-0 bg-transparent p-0"
                      >
                        <Badge
                          variant="outline"
                          className={cn(
                            "gap-1",
                            git.onDefaultBranch
                              ? "border-border bg-transparent text-muted-foreground"
                              : "border-primary/40 bg-primary/10 text-primary",
                          )}
                        >
                          <GitBranchIcon />
                          {git.onDefaultBranch
                            ? t("documentPanel.mainLesson")
                            : branchLabel(git.branch)}
                        </Badge>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {git.onDefaultBranch
                        ? t("documentPanel.variationsTooltip")
                        : t("documentPanel.onVariationTooltip")}
                    </TooltipContent>
                  </Tooltip>
                )}

                {editingId && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" onClick={handleFork}>
                        <GitForkIcon data-icon="inline-start" />
                        {t("documentPanel.forkButton")}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {t("documentPanel.forkTooltip")}
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* This lesson is a fork. Offer to pull in whatever the original
                  has changed since — merged block by block. */}
                {forkedFrom && hasApi() && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleSyncUpstream}
                        disabled={busy !== null}
                        className="text-primary hover:bg-primary/10 hover:text-primary"
                      >
                        <GitMergeIcon data-icon="inline-start" />
                        {busy === "merge"
                          ? t("documentPanel.syncChecking")
                          : t("documentPanel.syncWith", {
                              name: forkedFromTitle || t("labels.theOriginal"),
                            })}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {t("documentPanel.syncTooltip", {
                        name: forkedFromTitle || t("labels.theOriginalLesson"),
                      })}
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Offer this fork's work back to the lesson it came from. It goes
                  as a proposal for that lesson's author (or a trusted
                  collaborator) to review — a fork never writes the original.
                  Once one is open, the same button updates it rather than
                  opening a second one about the same work. */}
                {forkedFrom && canPropose && hasApi() && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        onClick={
                          openProposal
                            ? handleUpdateProposal
                            : () => setProposeOpen(true)
                        }
                        disabled={busy !== null || proposing}
                      >
                        <GitPullRequestIcon data-icon="inline-start" />
                        {openProposal
                          ? t("documentPanel.updateProposalButton")
                          : t("documentPanel.proposeButton", {
                              name: forkedFromTitle || t("labels.theOriginal"),
                            })}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {openProposal
                        ? t("documentPanel.updateProposalTooltip", {
                            title: openProposal.title,
                          })
                        : t("documentPanel.proposeTooltip", {
                            name:
                              forkedFromTitle || t("labels.theOriginalLesson"),
                          })}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
          </div>

          {/* Until the saved draft has hydrated from storage, show section
            placeholders rather than the doc's empty starter state — otherwise the
            "No sections yet" panel flashes for a beat before the real sections pop
            in. The same applies while a hub lesson is being fetched into an as-yet
            empty editor (sectionCount === 0 && editLoading). */}
          {!hydrated ? (
            <div className="mt-4">
              <SectionsSkeleton />
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-col gap-4">
                {/* eslint-disable-next-line react-hooks/refs -- capitalizedWords is a stable cached array, safe to read here */}
                {doc.sections.map((section, i) => (
                  <SectionCard
                    key={section.id}
                    section={section}
                    documentName={doc.title}
                    index={i}
                    onChange={updateSection}
                    onDelete={deleteSection}
                    onMove={moveSection}
                    isFirst={i === 0}
                    isLast={i === sectionCount - 1}
                    onError={handleSectionError}
                    capitalizedWords={capitalizedWords}
                    // A plain boolean, so collapsing one section leaves every
                    // other card's props identical and it stays memoized.
                    collapsed={collapsedIds.has(section.id)}
                    onToggleCollapse={toggleCollapse}
                    springOpenMs={SPRING_OPEN_MS}
                    // Drag state reaches each card as plain values scoped to that
                    // card, so hovering one section doesn't re-render the others.
                    dragBlockId={drag?.blockId ?? null}
                    overId={
                      drag?.overSectionId === section.id ? drag.overId : null
                    }
                    overPos={
                      drag?.overSectionId === section.id ? drag.overPos : null
                    }
                    isDropSection={drag?.overSectionId === section.id}
                    onBlockDragStart={startBlockDrag}
                    onBlockDragOver={hoverBlockDrag}
                    onBlockDragLeave={leaveBlockDrag}
                    onBlockDrop={dropBlockDrag}
                    onBlockDragEnd={endBlockDrag}
                  />
                ))}
              </div>

              {sectionCount === 0 &&
                (editLoading ? (
                  <div className="mt-4">
                    <SectionsSkeleton />
                  </div>
                ) : (
                  <div className="mt-4 rounded-md border border-dashed border-border p-12 text-center">
                    <p className="mb-1 text-lg font-semibold">
                      {t("emptyState.heading")}
                    </p>
                    <p className="mb-4 text-sm text-muted-foreground">
                      <Trans
                        i18nKey="emptyState.instruction"
                        ns="editor"
                        components={{ strong: <strong /> }}
                      />
                    </p>
                    <div className="flex flex-col justify-center gap-3 sm:flex-row">
                      <Button onClick={openAddDialog}>
                        <PlusIcon data-icon="inline-start" />
                        {t("emptyState.addSection")}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={openImportWarning}
                        disabled={busy !== null}
                      >
                        <FileUpIcon data-icon="inline-start" />
                        {t("header.importWord")}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={triggerJsonImportPicker}
                        disabled={busy !== null}
                      >
                        <BracesIcon data-icon="inline-start" />
                        {t("header.importJson")}
                      </Button>
                    </div>
                  </div>
                ))}
            </>
          )}
        </div>

        {/* The third pane. LessonView is the very same renderer the public
            lesson page uses, so this costs nothing to build and nothing to keep
            true — it re-renders from `doc` like everything else. The preview
            dialog is still there for narrower screens; this is the same view
            without the interruption. */}
        <aside className="sticky top-[calc(var(--header-h)+1.5rem)] hidden w-[22rem] shrink-0 @min-[70rem]/page:block">
          <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("previewDialog.title")}
          </p>
          <div className="max-h-[calc(100dvh-var(--header-h)-6rem)] overflow-y-auto rounded-panel border border-border bg-card shadow-(--shadow-panel)">
            <LessonView doc={doc} />
          </div>
        </aside>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-lg"
            onClick={openAddDialog}
            aria-label={t("addSectionFab.ariaLabel")}
            className="mb-safe fixed right-4 bottom-4 z-40 size-14 rounded-full shadow-[var(--shadow-panel)] sm:right-8 sm:bottom-8"
          >
            <PlusIcon className="size-6" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("addSectionFab.tooltip")}</TooltipContent>
      </Tooltip>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("newSectionDialog.title")}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="new-section-name" className="sr-only">
              {t("newSectionDialog.nameLabel")}
            </FieldLabel>
            <Input
              id="new-section-name"
              autoFocus
              placeholder={t("newSectionDialog.defaultName", {
                n: sectionCount + 1,
              })}
              value={newSectionName}
              onChange={(e) => setNewSectionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmAddSection();
              }}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("newSectionDialog.cancel")}
            </Button>
            <Button onClick={confirmAddSection}>
              {t("newSectionDialog.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[90dvh] w-full flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("previewDialog.title")}</DialogTitle>
          </DialogHeader>
          {/* LessonView draws the lesson in the current theme; the wrapper
              supplies only the dialog's frame and scrolling. */}
          <div className="overflow-y-auto rounded-md border border-border">
            <LessonView doc={doc} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              {t("previewDialog.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hidden picker for Word import, triggered from the warning dialog. */}
      <input
        ref={importInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        hidden
        onChange={handleImportFile}
      />

      {/* Hidden picker for JSON import (no warning dialog — the format is ours). */}
      <input
        ref={jsonInputRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={handleImportJsonFile}
      />

      {/* Warn before importing: the docx → lesson conversion is best-effort. */}
      <Dialog open={importWarnOpen} onOpenChange={setImportWarnOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("wordImportWarning.title")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              <Trans
                i18nKey="wordImportWarning.body1"
                ns="editor"
                components={[
                  <strong key="0" className="text-foreground" />,
                  <strong key="1" className="text-foreground" />,
                ]}
              />
            </p>
            <p>
              <Trans
                i18nKey="wordImportWarning.body2"
                ns="editor"
                components={[<strong key="0" className="text-foreground" />]}
              />
            </p>
            <p>{t("wordImportWarning.body3")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportWarnOpen(false)}>
              {t("wordImportWarning.cancel")}
            </Button>
            <Button onClick={triggerImportPicker}>
              <FileUpIcon data-icon="inline-start" />
              {t("wordImportWarning.chooseFile")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Refusal: a readable file that isn't structured as a lesson. The editor
          is left untouched; we just explain why it couldn't be opened. */}
      <Dialog
        open={Boolean(importError)}
        onOpenChange={(next) => !next && setImportError(null)}
      >
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlertIcon className="size-5 text-focus" />
              {t("importErrorDialog.title")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{importError}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportError(null)}>
              {t("importErrorDialog.close")}
            </Button>
            <Button
              onClick={() => {
                setImportError(null);
                const ref =
                  importErrorSource === "json" ? jsonInputRef : importInputRef;
                ref.current?.click();
              }}
            >
              <FileUpIcon data-icon="inline-start" />
              {t("importErrorDialog.tryAnotherFile")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FirstLessonWizard open={wizardOpen} onClose={closeWizard} />

      <AiLessonIdeaDialog
        open={ideaDialogOpen}
        ageRange={doc.ageRange || ""}
        onSelect={setTitle}
        onClose={() => setIdeaDialogOpen(false)}
      />

      <CollaborateDialog
        open={collabOpen}
        onClose={() => openPanel(null)}
        collab={collab}
        initialJoinCode={joinCode}
        trusted={doc.trustedCollaborators || []}
        onTrustedChange={setTrustedCollaborators}
      />

      {/* Every lesson this device is holding. Switching between them is the one
          thing the editor could not do before: there was a single working
          document, and opening anything meant overwriting it. */}
      <LessonsDialog
        open={lessonsOpen}
        onClose={() => openPanel(null)}
        lessons={localLessons}
        currentId={localId}
        onRefresh={refreshLocalLessons}
        onOpen={openLocalLesson}
        onCreate={startNewLesson}
        onDuplicate={duplicateLocalLesson}
        onDelete={removeLocalLesson}
        onRename={renameLocalLesson}
      />

      {/* Variations: the other branches of this lesson's repository, as an author
          sees them — separate copies to try things in. */}
      <VariationsDialog
        open={variationsOpen}
        onClose={() => openPanel(null)}
        git={git}
        onSwitch={(next) => next && setDoc(next)}
        onBringIn={handleBringVariationIn}
      />

      {/* The lesson's own version history, read out of its git repository. */}
      <HistoryDialog
        open={historyOpen}
        onClose={() => openPanel(null)}
        git={git}
        onRestore={setDoc}
        onUndo={handleUndoCommit}
      />

      {/* Settling a merge with the lesson this one was forked from. Only blocks
          both sides changed in the same place reach the user; everything else has
          already merged by the time this opens. */}
      <ProposeChangesDialog
        open={proposeOpen}
        lessonTitle={forkedFromTitle}
        busy={proposing}
        onClose={() => setProposeOpen(false)}
        onSubmit={handleProposeChanges}
      />

      <MergeDialog
        // Keyed on the merge's own commits, so each merge opens with a fresh set
        // of choices rather than inheriting the last one's.
        key={merge ? `${merge.ours}-${merge.theirs}` : "no-merge"}
        open={Boolean(merge)}
        // Backing out of a merge abandons the review it belonged to as well —
        // otherwise a later, unrelated merge would find a proposal still waiting
        // to be landed and land it.
        onClose={() => {
          setMerge(null);
          setMergeVariation(null);
          setMergeProposalTitle("");
          setReviewPull(null);
        }}
        prepared={merge}
        intent={mergeIntent}
        theirName={theirNameFor(mergeIntent, { dialog: true })}
        proposerName={reviewPull?.author || ""}
        onConfirm={confirmMerge}
        busy={merging}
      />

      {/* Floating avatars showing where each collaborator is editing. */}
      <CollabCursors selections={collab.selections} />

      {/* Floating live-chat panel, pinned to the bottom-left while collaborating. */}
      <CollabChat collab={collab} />

      {editLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Spinner className="size-10 text-white" />
        </div>
      )}
    </>
  );
}
