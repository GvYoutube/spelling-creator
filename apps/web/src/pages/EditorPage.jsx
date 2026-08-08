import { hasApi } from "@spelling-creator/core/config";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useDocumentMeta } from "../lib/seo.js";
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
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HistoryIcon,
  PlusIcon,
  PrinterIcon,
  SaveIcon,
  SparklesIcon,
  SpellCheckIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import AppHeader from "../components/AppHeader.jsx";
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
import NavActions from "../components/NavActions.jsx";
import CollaborateDialog from "../components/CollaborateDialog.jsx";
import CollabCursors from "../components/CollabCursors.jsx";
import CollabChat from "../components/CollabChat.jsx";
import FirstLessonWizard from "../components/FirstLessonWizard.jsx";
import AiLessonIdeaDialog from "../components/AiLessonIdeaDialog.jsx";
import HistoryDialog, { timeAgo } from "../components/HistoryDialog.jsx";
import MergeDialog from "../components/MergeDialog.jsx";
import { AGE_RANGES } from "@spelling-creator/core/ageRanges";
import { newId } from "@spelling-creator/core/id";
import { extractCapitalizedWords } from "@spelling-creator/core/spelling";
import { useLessonGit } from "../lib/git/useLessonGit.js";
// The git engine (isomorphic-git + LightningFS) is loaded on demand rather than
// imported directly, so it stays out of the bundle every homepage and hub visitor
// downloads. loadGitEngine() memoises the import; by the time any of these flows
// runs, useLessonGit has already fetched the chunk.
import { loadGitEngine } from "../lib/git/load.js";
import {
  loadDocument,
  saveDocument,
  loadEditingId,
  saveEditingId,
  loadEditingPublished,
  saveEditingPublished,
  loadForkedFrom,
  saveForkedFrom,
  loadWizardSeen,
  saveWizardSeen,
  migrateLocalStorage,
} from "@spelling-creator/core/browser/storage";
import { convertDocImages } from "@spelling-creator/core/browser/imageRef";
import { ensureImagesUploaded } from "@spelling-creator/core/imagesClient";
import { exportDocx } from "@spelling-creator/core/browser/docxExport";
import { importDocxFile } from "@spelling-creator/core/browser/docxImport";
import { exportJson } from "@spelling-creator/core/browser/jsonExport";
import { importJsonFile } from "@spelling-creator/core/jsonImport";
import { exportPdf } from "@spelling-creator/core/browser/pdfExport";
import {
  previewHtml,
  PREVIEW_STYLES,
} from "@spelling-creator/core/browser/htmlPreview";
import { hasGoogleDrive } from "@spelling-creator/core/config";
import { saveToGoogleDrive } from "@spelling-creator/core/browser/googleDrive";
import {
  publishLesson,
  updateLesson,
  fetchLesson,
  EDIT_REQUEST_KEY,
  FORK_REQUEST_KEY,
} from "@spelling-creator/core/lessons";
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

// Whether a document holds work worth protecting from being clobbered. The
// starter doc has no sections; once the user has added one, replacing the doc
// (e.g. by opening a published lesson to edit) is destructive and warrants a
// warning.
function docHasContent(d) {
  return Boolean(d && Array.isArray(d.sections) && d.sections.length > 0);
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
  useDocumentMeta();
  const { t } = useTranslation("editor");
  const [doc, setDoc] = useState(() => createInitialDoc(t));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [ideaDialogOpen, setIdeaDialogOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [busy, setBusy] = useState(null); // 'docx' | 'pdf' | 'gdocs' | 'preview' | 'publish' | 'import' | null
  const [previewContent, setPreviewContent] = useState(null); // HTML string | null
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

  // Hub-editing state. `editingId` is the id of a published lesson currently
  // loaded for editing (so "Publish" becomes "Update"); null when authoring a
  // fresh lesson. It's persisted to localStorage (see effect below) so the
  // status survives reloads and tab closes until the user overwrites it (by
  // opening another published lesson) or forks into a new lesson.
  // `pendingEdit` holds a fetched lesson awaiting the user's confirmation to
  // overwrite their in-progress work; `editLoading` covers the fetch of the
  // lesson to edit.
  const [editingId, setEditingId] = useState(null);
  // Whether the lesson loaded for editing is published to the hub or a private
  // draft. Only meaningful when `editingId` is set; it tunes the "Save to cloud"
  // actions and the status chip. Persisted so it survives reloads.
  const [editingPublished, setEditingPublished] = useState(true);
  const [pendingEdit, setPendingEdit] = useState(null); // { id, title, doc, published } | null
  const [editLoading, setEditLoading] = useState(false);

  // Version control. The lesson is kept in a real git repository in the browser,
  // one file per content block (see lib/git/), committed automatically whenever
  // the user pauses. `forkedFrom` is the lesson this one was forked from, if any:
  // it's what lets us later pull the original's changes in, merging the two
  // histories against the commit they diverged from. Persisted with the draft.
  const [forkedFrom, setForkedFrom] = useState(null);
  const [forkedFromTitle, setForkedFromTitle] = useState("");
  // Whether the original's author trusts us — i.e. our email is on ITS
  // trusted-collaborator list. Only then may we merge this fork back into it.
  // The Worker enforces the same check; this only decides whether to offer it.
  const [canContribute, setCanContribute] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // A merge the user is being asked to settle: the result of prepareMerge, held
  // until they've chosen how to resolve any conflicts (see MergeDialog).
  const [merge, setMerge] = useState(null);
  const [merging, setMerging] = useState(false);
  // What to do once the merge is settled:
  //   "pull"       just take the original's changes into this fork
  //   "contribute" ...then push the result back into the original (trusted only)
  //   "publish"    a save found the hub ahead of us; merge, then save again
  const [mergeIntent, setMergeIntent] = useState("pull");

  const {
    enabled: authEnabled,
    accessToken,
    loading: authLoading,
    user,
  } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const showPublish = hasApi() && authEnabled;

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
  const [collabOpen, setCollabOpen] = useState(false);

  // Editor state hydrates from IndexedDB (below), and `hydrated` gates this so
  // version control never commits the empty starter doc over a real draft's
  // history before that draft has loaded.
  const [hydrated, setHydrated] = useState(false);
  const git = useLessonGit({ doc, editingId, identity, enabled: hydrated });

  // First-lesson wizard. Auto-shows once for newcomers (tracked by a
  // localStorage flag); dismissing it sets the flag so it won't reappear. The
  // help button reopens it on demand without touching the flag.
  const [wizardOpen, setWizardOpen] = useState(false);

  // Editor state lives in IndexedDB now (async), so we hydrate it on mount
  // rather than synchronously at useState time. `hydrated` gates the persistence
  // effects below so they don't write the empty starter doc over a saved draft
  // before it loads, and defers the hub edit/fork request until we know whether
  // there's in-progress work to protect. migrateLocalStorage() first moves any
  // pre-IndexedDB draft across (a one-time, idempotent no-op afterwards).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await migrateLocalStorage();
      const [savedDoc, savedEditingId, savedPublished, savedFork, seen] =
        await Promise.all([
          loadDocument(),
          loadEditingId(),
          loadEditingPublished(),
          loadForkedFrom(),
          loadWizardSeen(),
        ]);
      if (cancelled) return;
      if (savedDoc) setDoc(savedDoc);
      if (savedEditingId) setEditingId(savedEditingId);
      if (savedFork) setForkedFrom(savedFork);
      setEditingPublished(savedPublished);
      if (!seen) setWizardOpen(true);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The lesson this one was forked from: its name (for the sync/merge-back buttons
  // and the merge dialog), and whether its author trusts us enough to let us merge
  // back into it. Fetched lazily; a failure just leaves the generic wording and no
  // merge-back offer.
  useEffect(() => {
    if (!forkedFrom) {
      setForkedFromTitle("");
      setCanContribute(false);
      return;
    }
    let cancelled = false;
    fetchLesson(forkedFrom, accessToken)
      .then((lesson) => {
        if (cancelled) return;
        setForkedFromTitle(lesson.title || "");

        // The trusted list lives on the original's own document — the same list
        // its author manages in the collaboration dialog. Being on it is what
        // makes this fork mergeable back into the original. The Worker re-checks
        // it on every write, so this is only about whether to show the button.
        const trusted = lesson.doc?.trustedCollaborators;
        const mine = (user?.email || "").trim().toLowerCase();
        setCanContribute(
          Boolean(mine) &&
            Array.isArray(trusted) &&
            trusted.some(
              (t) => (t?.email || "").trim().toLowerCase() === mine,
            ) &&
            // The author doesn't need to "contribute" to their own lesson —
            // they'd just save it.
            lesson.authorId !== user?.id,
        );
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
      setCollabOpen(true);
    }
  }, [joinCode]);

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

  // Persist the working doc to IndexedDB, debounced: typing into a large lesson
  // shouldn't rewrite the whole document on every keystroke (the synchronous
  // write janks low-end machines). We save ~600ms after edits pause, and flush a
  // pending save on unmount so the last keystrokes aren't lost.
  const pendingSaveRef = useRef(null);
  useEffect(() => {
    if (!hydrated) return;
    pendingSaveRef.current = doc;
    const id = setTimeout(() => {
      pendingSaveRef.current = null;
      saveDocument(doc);
    }, 600);
    return () => clearTimeout(id);
  }, [doc, hydrated]);
  useEffect(
    () => () => {
      if (pendingSaveRef.current) saveDocument(pendingSaveRef.current);
    },
    [],
  );

  // Persist the editing-published status so it survives reloads/tab closes.
  useEffect(() => {
    if (hydrated) saveEditingId(editingId);
  }, [editingId, hydrated]);

  // Persist whether the edited lesson is published or a draft. Clear it when no
  // lesson is attached, so a fresh document defaults back to "publish".
  useEffect(() => {
    if (hydrated) saveEditingPublished(editingId ? editingPublished : null);
  }, [editingId, editingPublished, hydrated]);

  // Persist the lesson this one was forked from, so the link home survives a
  // reload and the fork can still be synced with its original days later.
  useEffect(() => {
    if (hydrated) saveForkedFrom(forkedFrom);
  }, [forkedFrom, hydrated]);

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

  // Adopt a fetched lesson into the editor: replace the working doc (this is the
  // step that overwrites the auto-saved draft). For an edit, enter edit mode so
  // "Publish" becomes "Update" on the original row. For a fork, load it as a
  // fresh, unattached draft (editingId stays null) titled "… (copy)", so
  // publishing creates a separate lesson and the original is left untouched.
  const applyEdit = async ({
    id,
    doc: nextDoc,
    mode,
    source,
    published,
    forkedFrom: incomingFork,
  }) => {
    if (mode === "import") {
      // An imported doc loads as a fresh, unattached lesson (like a fork, but
      // keeping the document's own title): saving it later creates a new cloud
      // lesson rather than overwriting anything.
      //
      // Its history starts here too. An imported lesson has no relationship to
      // whatever was in the editor before, so the draft repo is thrown away
      // rather than having the import committed on top of an unrelated timeline.
      await git.discard();
      setDoc(nextDoc);
      setEditingId(null);
      setForkedFrom(null);
      setEditingPublished(true);
      setPendingEdit(null);
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
      // A lesson published before this feature has no repo to clone. The fork
      // still works and still gets history from here on; it just has no common
      // ancestor with the original, so a later sync compares the two directly.
      let cloned = false;
      try {
        const engine = await loadGitEngine();
        cloned = Boolean(await engine.forkLessonRepo(id));
      } catch {
        /* no history to clone — fall through to a fresh one */
      }

      setDoc({
        ...nextDoc,
        title: t("labels.copyOf", {
          title: nextDoc.title || t("labels.untitledLesson"),
        }),
      });
      setEditingId(null);
      setForkedFrom(id);
      setEditingPublished(true);
      setPendingEdit(null);
      git.reload();
      notify({
        severity: "info",
        message: cloned
          ? t("messages.forkedWithHistory")
          : t("messages.forkedWithoutHistory"),
      });
      return;
    }
    setDoc(nextDoc);
    setEditingId(id);
    setForkedFrom(incomingFork || null);
    setEditingPublished(published);
    setPendingEdit(null);
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
        // Edit can adopt straight away when re-opening the same lesson; either
        // mode adopts when there's no in-progress work to lose. Otherwise warn.
        if (
          (mode === "edit" && editingIdRef.current === lesson.id) ||
          !docHasContent(docRef.current)
        ) {
          applyEditRef.current(incoming);
        } else {
          setPendingEdit(incoming);
        }
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
        await exportDocx(doc);
        notify({ severity: "success", message: t("messages.wordDownloaded") });
      } else if (kind === "json") {
        exportJson(doc);
        notify({ severity: "success", message: t("messages.jsonDownloaded") });
      } else {
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

  const handlePreview = async () => {
    if (doc.sections.length === 0) {
      notify({
        severity: "warning",
        message: t("messages.addSectionBeforePreviewing"),
      });
      return;
    }
    setBusy("preview");
    try {
      const html = await previewHtml(doc);
      setPreviewContent(html);
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.previewFailed", { error: err.message || err }),
      });
    } finally {
      setBusy(null);
    }
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

  // Detach the working doc from the published lesson it was loaded from, so the
  // next "Publish" creates a new lesson instead of updating the original. This
  // is the explicit way to leave the editing-published status (the status
  // otherwise persists across reloads).
  //
  // Like forking from the hub, this clones the lesson's repository rather than
  // just copying its text: the new lesson keeps the history and shares ancestry
  // with the one it left, so it can be merged back with it later.
  const handleFork = async () => {
    const from = editingId;
    if (from) {
      await git.commitNow();
      try {
        const engine = await loadGitEngine();
        await engine.forkLocalRepo(from);
      } catch {
        /* no local history to carry over — the fork starts a fresh one */
      }
    }
    setEditingId(null);
    setForkedFrom(from || null);
    setEditingPublished(true);
    git.reload();
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

  // Merge this fork BACK into the lesson it was forked from — the trusted
  // collaborator's contribution.
  //
  // Only offered when the original's author put us on its trusted-collaborator
  // list (the same list that auto-admits us to a live session). The Worker checks
  // that independently; this is just the UI gate.
  //
  // The order matters. We first pull the original in, so our history *contains*
  // its current tip — a push can then only move it forward, never erase the
  // author's commits. If that pull raises conflicts, they're settled in the merge
  // dialog first, and the contribution is finished by confirmMerge below.
  const handleContribute = async () => {
    if (!forkedFrom || !canContribute) return;
    setBusy("contribute");
    try {
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
          message: t("messages.noSharedHistoryToContribute"),
        });
        return;
      }
      if (prepared.identical) {
        notify({
          severity: "info",
          message: t("messages.identicalCopy", {
            name: forkedFromTitle || t("labels.theOriginal"),
          }),
        });
        return;
      }

      // Already sitting on top of the original: nothing to pull, so push straight
      // away. Otherwise settle the merge first (confirmMerge finishes the push).
      if (prepared.ahead) {
        await contributeUpstream(prepared, doc);
        return;
      }

      setMergeIntent("contribute");
      setMerge(prepared);
    } catch (err) {
      console.error(err);
      notify({
        severity: "error",
        message: t("messages.couldNotMergeBack", {
          error: err.message || err,
        }),
      });
    } finally {
      setBusy(null);
    }
  };

  // Push our (already-merged) history and document into the original lesson.
  // `prepared.theirs` is the original's tip we merged, and doubles as the
  // compare-and-swap: if the original moved on in the meantime, the Worker
  // rejects the push rather than dropping whatever landed there.
  const contributeUpstream = async (prepared, mergedDoc) => {
    const engine = await loadGitEngine();

    // History first, document second. If the push is rejected, the original's doc
    // row must be left exactly as it was.
    await engine.pushToUpstream({
      repoId: git.repoId,
      upstreamLessonId: forkedFrom,
      expectedHead: prepared.theirs,
      accessToken,
    });
    await updateLesson(forkedFrom, mergedDoc, accessToken);

    notify({
      severity: "success",
      message: t("messages.mergedIntoUpstream", {
        name: forkedFromTitle || t("labels.theOriginalLesson"),
      }),
      route: { to: `/hub/${forkedFrom}`, label: t("labels.viewLesson") },
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
        theirName: mergeIntent === "publish" ? doc.title : forkedFromTitle,
        currentDoc: doc,
      });
      setDoc(merged);
      const intent = mergeIntent;
      setMerge(null);

      if (intent === "contribute") {
        await contributeUpstream(merge, merged);
        return;
      }
      if (intent === "publish") {
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
      const imported = await importDocxFile(file);
      // Reuse the overwrite-confirmation flow when there's in-progress work to
      // lose; otherwise load straight away.
      const incoming = {
        doc: imported,
        title: imported.title,
        mode: "import",
        source: "word",
      };
      if (docHasContent(doc)) setPendingEdit(incoming);
      else applyEdit(incoming);
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
      const incoming = {
        doc: imported,
        title: imported.title,
        mode: "import",
        source: "json",
      };
      if (docHasContent(doc)) setPendingEdit(incoming);
      else applyEdit(incoming);
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

  // Header icon-only triggers (help, the logo/import menu, the mobile
  // overflow menu) sit on AppHeader's --primary surface, so they use
  // --primary-foreground rather than the usual tokens — see the note at the
  // top of NavActions.jsx, whose iconTrigger this mirrors.
  const headerIconTrigger =
    "relative inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10";
  const headerGhostButton =
    "text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground";

  // The small "N collaborators online" dot, overlaid on whichever trigger
  // shows it (the mobile overflow menu, the desktop Collaborate button).
  const collabCount = collab.active ? collab.participants.length : 0;
  const CollabDot = collabCount > 0 && (
    <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-success text-[10px] font-medium text-success-foreground">
      {collabCount}
    </span>
  );

  return (
    <div className="min-h-dvh bg-background pb-24 text-foreground">
      <AppHeader
        title={t("header.title")}
        left={
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("header.menuAriaLabel")}
                    className={cn(headerIconTrigger, "mr-1")}
                  >
                    <SpellCheckIcon />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("header.menuTooltip")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
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
        }
      >
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
            <DropdownMenuItem onClick={() => setCollabOpen(true)}>
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
          <Button
            variant="ghost"
            onClick={handlePreview}
            disabled={busy !== null}
            className={headerGhostButton}
          >
            {busy === "preview" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <EyeIcon data-icon="inline-start" />
            )}
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
                  onClick={() => setCollabOpen(true)}
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

        <NavActions current="editor" />
      </AppHeader>

      <div className="mx-auto max-w-3xl px-4 pt-6">
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
                <SelectItem value="any">{t("documentPanel.anyAge")}</SelectItem>
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
                      onClick={() => setHistoryOpen(true)}
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
                          ? t("history.unsavedChanges", { count: git.pending })
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

              {/* We're a trusted collaborator on the lesson this was forked from,
                  so we can merge our work back INTO it — the contribution flow.
                  Anyone else can fork and sync, but only push their own copy. */}
              {forkedFrom && canContribute && hasApi() && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      onClick={handleContribute}
                      disabled={busy !== null}
                    >
                      <GitPullRequestIcon data-icon="inline-start" />
                      {busy === "contribute"
                        ? t("documentPanel.contributeMerging")
                        : t("documentPanel.contributeButton", {
                            name: forkedFromTitle || t("labels.theOriginal"),
                          })}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {t("documentPanel.contributeTooltip", {
                      name: forkedFromTitle || t("labels.theOriginalLesson"),
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

      <Dialog
        open={Boolean(previewContent)}
        onOpenChange={(next) => !next && setPreviewContent(null)}
      >
        <DialogContent className="flex max-h-[90dvh] w-full flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("previewDialog.title")}</DialogTitle>
          </DialogHeader>
          <div
            className="s2c-preview-root overflow-y-auto rounded-md border border-border bg-white p-4 text-[#1a1a1a]"
            dangerouslySetInnerHTML={{
              __html: `<style>${PREVIEW_STYLES}</style>${previewContent || ""}`,
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewContent(null)}>
              {t("previewDialog.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Overwrite warning: opening a published lesson for editing replaces the
          working doc (and its auto-saved draft). Confirm before discarding it. */}
      <Dialog
        open={Boolean(pendingEdit)}
        onOpenChange={(next) => !next && setPendingEdit(null)}
      >
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("overwriteDialog.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <Trans
              i18nKey={
                pendingEdit?.mode === "fork"
                  ? "overwriteDialog.forkBody"
                  : pendingEdit?.mode === "import"
                    ? "overwriteDialog.importBody"
                    : "overwriteDialog.editBody"
              }
              ns="editor"
              values={{
                title: pendingEdit?.title || t("overwriteDialog.thisLesson"),
              }}
              components={{ strong: <strong /> }}
            />
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingEdit(null)}>
              {t("overwriteDialog.keepMyWork")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => applyEdit(pendingEdit)}
            >
              {pendingEdit?.mode === "fork"
                ? t("overwriteDialog.replaceAndFork")
                : pendingEdit?.mode === "import"
                  ? t("overwriteDialog.replaceAndImport")
                  : t("overwriteDialog.replaceAndEdit")}
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
        onClose={() => setCollabOpen(false)}
        collab={collab}
        initialJoinCode={joinCode}
        trusted={doc.trustedCollaborators || []}
        onTrustedChange={setTrustedCollaborators}
      />

      {/* The lesson's own version history, read out of its git repository. */}
      <HistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        git={git}
        onRestore={setDoc}
      />

      {/* Settling a merge with the lesson this one was forked from. Only blocks
          both sides changed in the same place reach the user; everything else has
          already merged by the time this opens. */}
      <MergeDialog
        // Keyed on the merge's own commits, so each merge opens with a fresh set
        // of choices rather than inheriting the last one's.
        key={merge ? `${merge.ours}-${merge.theirs}` : "no-merge"}
        open={Boolean(merge)}
        onClose={() => setMerge(null)}
        prepared={merge}
        intent={mergeIntent}
        theirName={
          mergeIntent === "publish"
            ? t("labels.theSavedLesson")
            : forkedFromTitle || t("labels.theOriginal")
        }
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
    </div>
  );
}
