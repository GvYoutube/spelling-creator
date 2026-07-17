import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useDocumentMeta } from "../lib/seo.js";
// Snackbar stays MUI for now — see the note in ModerationPage.jsx.
import Snackbar from "@mui/material/Snackbar";
import MuiAlert from "@mui/material/Alert";
import MuiButton from "@mui/material/Button";
import {
  BracesIcon,
  ChevronDownIcon,
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
import { AGE_RANGES } from "../lib/ageRanges.js";
import { newId } from "../lib/id.js";
import { extractCapitalizedWords } from "../lib/spelling.js";
import { useLessonGit } from "../lib/git/useLessonGit.js";
// The git engine (isomorphic-git + LightningFS) is loaded on demand rather than
// imported directly, so it stays out of the bundle every homepage and hub visitor
// downloads. loadGitEngine() memoises the import; by the time any of these flows
// runs, useLessonGit has already fetched the chunk.
import { loadGitEngine } from "../lib/git/load.js";
import { gitRemoteEnabled } from "../lib/git/remote.js";
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
} from "../lib/storage.js";
import { convertDocImages } from "../lib/imageRef.js";
import { ensureImagesUploaded } from "../lib/imagesClient.js";
import { exportDocx } from "../lib/docxExport.js";
import { importDocxFile } from "../lib/docxImport.js";
import { exportJson } from "../lib/jsonExport.js";
import { importJsonFile } from "../lib/jsonImport.js";
import { exportPdf } from "../lib/pdfExport.js";
import { previewHtml, PREVIEW_STYLES } from "../lib/htmlPreview.js";
import { saveToGoogleDrive, googleDriveEnabled } from "../lib/googleDrive.js";
import {
  publishLesson,
  updateLesson,
  fetchLesson,
  lessonHubEnabled,
  EDIT_REQUEST_KEY,
  FORK_REQUEST_KEY,
} from "../lib/lessons.js";
import { useAuth } from "../lib/auth.jsx";
import { useCollaboration } from "../lib/collab.js";
import { useSelectionBroadcast } from "../lib/useSelectionBroadcast.js";
import { useDragAutoScroll } from "../lib/useDragAutoScroll.js";

// The starter document a fresh editor opens with. Any persisted draft is loaded
// asynchronously from IndexedDB on mount (see the hydration effect) and replaces
// this once available.
function createInitialDoc() {
  return { title: "Put your topic here...", sections: [] };
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
  const [doc, setDoc] = useState(createInitialDoc);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [ideaDialogOpen, setIdeaDialogOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [busy, setBusy] = useState(null); // 'docx' | 'pdf' | 'gdocs' | 'preview' | 'publish' | 'import' | null
  const [toast, setToast] = useState(null); // { severity, message }
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
  const showPublish = lessonHubEnabled && authEnabled;

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
      setToast({
        severity: "info",
        message:
          source === "json"
            ? "Imported from JSON. Review the lesson, then save it to the cloud when you're ready."
            : "Imported from Word. Word import is best-effort — review the lesson, as some formatting or content may have been lost.",
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
        title: `${nextDoc.title || "Untitled Lesson"} (copy)`,
      });
      setEditingId(null);
      setForkedFrom(id);
      setEditingPublished(true);
      setPendingEdit(null);
      git.reload();
      setToast({
        severity: "info",
        message: cloned
          ? "Forked into a new lesson — its full history came with it. Edit freely, then save it as your own copy."
          : "Forked into a new lesson — edit freely, then save it to the cloud as your own copy.",
      });
      return;
    }
    setDoc(nextDoc);
    setEditingId(id);
    setForkedFrom(incomingFork || null);
    setEditingPublished(published);
    setPendingEdit(null);
    setToast({
      severity: "info",
      message: published
        ? "Loaded your published lesson — edit and save to the cloud to update it."
        : "Loaded your draft — edit and save to the cloud, or publish it to the hub.",
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
        setToast({
          severity: "error",
          message:
            err.message ||
            `Could not open that lesson for ${mode === "fork" ? "forking" : "editing"}.`,
        });
      })
      .finally(() => setEditLoading(false));
  }, [hydrated, authLoading, accessToken]);

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
    (id, dir) =>
      setDoc((d) => {
        const from = d.sections.findIndex((s) => s.id === id);
        const to = from + dir;
        if (from === -1 || to < 0 || to >= d.sections.length) return d;
        const sections = [...d.sections];
        const [moved] = sections.splice(from, 1);
        sections.splice(to, 0, moved);
        return { ...d, sections };
      }),
    [],
  );

  const handleSectionError = useCallback(
    (message) => setToast({ severity: "error", message }),
    [],
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

  const confirmAddSection = () => {
    const name = newSectionName.trim() || `Section ${doc.sections.length + 1}`;
    setDoc((d) => ({
      ...d,
      sections: [...d.sections, { id: newId(), name, blocks: [] }],
    }));
    setDialogOpen(false);
  };

  const handleExport = async (kind) => {
    if (doc.sections.length === 0) {
      setToast({
        severity: "warning",
        message: "Add at least one section before exporting.",
      });
      return;
    }
    setBusy(kind);
    try {
      if (kind === "docx") {
        await exportDocx(doc);
        setToast({ severity: "success", message: "Word document downloaded." });
      } else if (kind === "json") {
        exportJson(doc);
        setToast({ severity: "success", message: "Lesson JSON downloaded." });
      } else {
        await exportPdf(doc);
        setToast({
          severity: "success",
          message: "PDF generated for printing.",
        });
      }
    } catch (err) {
      console.error(err);
      setToast({
        severity: "error",
        message: `Export failed: ${err.message || err}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const handleSaveToGoogle = async () => {
    if (doc.sections.length === 0) {
      setToast({
        severity: "warning",
        message: "Add at least one section before saving.",
      });
      return;
    }
    setBusy("gdocs");
    try {
      const file = await saveToGoogleDrive(doc);
      setToast({
        severity: "success",
        message: "Saved to Google Drive as a Google Doc.",
        link: file.webViewLink
          ? { href: file.webViewLink, label: "Open" }
          : null,
      });
    } catch (err) {
      console.error(err);
      setToast({
        severity: "error",
        message: `Could not save to Google: ${err.message || err}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const handlePreview = async () => {
    if (doc.sections.length === 0) {
      setToast({
        severity: "warning",
        message: "Add at least one section before previewing.",
      });
      return;
    }
    setBusy("preview");
    try {
      const html = await previewHtml(doc);
      setPreviewContent(html);
    } catch (err) {
      console.error(err);
      setToast({
        severity: "error",
        message: `Preview failed: ${err.message || err}`,
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
      setToast({
        severity: "warning",
        message: "Add at least one section before saving.",
      });
      return;
    }
    // Saving requires a signed-in account — send the user to the login page (and
    // back) if they aren't authenticated yet.
    if (!accessToken) {
      setToast({
        severity: "info",
        message: "Please sign in to save your lesson to the cloud.",
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
      if (editingId && gitRemoteEnabled) {
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
          setToast({
            severity: "info",
            message:
              "Someone else has changed this lesson since you last synced. Merge their changes, then save again — nothing has been overwritten.",
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
      if (!editingId && lessonId && gitRemoteEnabled) {
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
          historyWarning =
            err.message || "the version history couldn't be saved";
        }
      }

      setToast({
        severity: historyWarning ? "warning" : "success",
        message: historyWarning
          ? `Lesson saved, but ${historyWarning}. Your history is safe on this device and will upload next time you save.`
          : publish
            ? "Lesson published to the hub."
            : "Draft saved to the cloud — only you can see it.",
        route:
          publish && !historyWarning
            ? { to: "/hub", label: "View hub" }
            : undefined,
      });
    } catch (err) {
      console.error(err);
      setToast({
        severity: "error",
        message: `Could not save: ${err.message || err}`,
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
    setToast({
      severity: "info",
      message:
        "Forked into a new lesson — saving to the cloud will create a separate copy.",
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
        setToast({
          severity: "info",
          message:
            "The original lesson has no shared history to merge — it may have been published before version history, or deleted.",
        });
        return;
      }
      if (prepared.upToDate) {
        setToast({
          severity: "success",
          message: "Already up to date with the original.",
        });
        return;
      }

      setMergeIntent("pull");
      setMerge(prepared);
    } catch (err) {
      console.error(err);
      setToast({
        severity: "error",
        message: `Could not merge: ${err.message || err}`,
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
        setToast({
          severity: "info",
          message:
            "The original lesson has no shared history, so there's nothing to merge back into.",
        });
        return;
      }
      if (prepared.identical) {
        setToast({
          severity: "info",
          message: `Your copy is identical to ${forkedFromTitle || "the original"} — there's nothing to merge back.`,
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
      setToast({
        severity: "error",
        message: `Could not merge back: ${err.message || err}`,
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

    setToast({
      severity: "success",
      message: `Merged your changes into ${forkedFromTitle || "the original lesson"}. Its author has been notified.`,
      route: { to: `/hub/${forkedFrom}`, label: "View lesson" },
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
        setToast({
          severity: "success",
          message:
            "Merged the changes from the hub. Save to the cloud again to publish the merged lesson.",
        });
        return;
      }
      setToast({
        severity: "success",
        message: `Merged the changes from ${forkedFromTitle || "the original"}.`,
      });
    } catch (err) {
      console.error(err);
      setToast({
        severity: "error",
        message: `Could not complete the merge: ${err.message || err}`,
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
      setImportError(
        err?.message ||
          "This Word document couldn't be imported. Please check it and try again.",
      );
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
      setImportError(
        err?.message ||
          "This JSON file couldn't be imported. Please check it and try again.",
      );
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
      ? "Update published lesson"
      : "Publish to hub";
  const draftActionLabel =
    editingId && !editingPublished ? "Update draft" : "Save as draft";

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
    <div className="min-h-screen bg-background pb-24 text-foreground">
      <AppHeader
        title="Spelling Lesson Maker"
        left={
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="menu"
                    className={cn(headerIconTrigger, "mr-1")}
                  >
                    <SpellCheckIcon />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Menu</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onClick={openImportWarning}
                disabled={busy !== null}
              >
                <FileUpIcon />
                Import Word document
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={triggerJsonImportPicker}
                disabled={busy !== null}
              >
                <BracesIcon />
                Import JSON
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
                GitHub
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
              aria-label="how to create a lesson"
              className={cn(headerIconTrigger, "md:hidden")}
            >
              <CircleHelpIcon />
            </button>
          </TooltipTrigger>
          <TooltipContent>How to create a lesson</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="lesson actions"
                  className={cn(headerIconTrigger, "md:hidden")}
                >
                  <EllipsisVerticalIcon />
                  {CollabDot}
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Lesson actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handlePreview} disabled={busy !== null}>
              <EyeIcon />
              Preview
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={openImportWarning}
              disabled={busy !== null}
            >
              <FileUpIcon />
              Import Word document
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={triggerJsonImportPicker}
              disabled={busy !== null}
            >
              <BracesIcon />
              Import JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => handleExport("docx")}
              disabled={busy !== null}
            >
              <FileTextIcon />
              Export DOCX
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport("json")}
              disabled={busy !== null}
            >
              <BracesIcon />
              Export JSON
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleExport("pdf")}
              disabled={busy !== null}
            >
              <PrinterIcon />
              Print PDF
            </DropdownMenuItem>
            {googleDriveEnabled && (
              <DropdownMenuItem
                onClick={handleSaveToGoogle}
                disabled={busy !== null}
              >
                <SaveIcon />
                Save to Google Docs
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
                ? `Collaborating (${collab.participants.length})`
                : "Collaborate"}
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
                aria-label="how to create a lesson"
                className={headerIconTrigger}
              >
                <CircleHelpIcon />
              </button>
            </TooltipTrigger>
            <TooltipContent>How to create a lesson</TooltipContent>
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
            Preview
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
                Export
                <ChevronDownIcon className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExport("docx")}>
                <FileTextIcon />
                Export DOCX
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("json")}>
                <BracesIcon />
                <div className="flex flex-col">
                  <span>Export JSON</span>
                  <span className="text-xs text-muted-foreground">
                    Re-importable lesson file
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("pdf")}>
                <PrinterIcon />
                Print PDF
              </DropdownMenuItem>
              {googleDriveEnabled && (
                <DropdownMenuItem onClick={handleSaveToGoogle}>
                  <SaveIcon />
                  Save to Google Docs
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
                  Save to cloud
                  <ChevronDownIcon className="opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleSaveToCloud(true)}>
                  <CloudUploadIcon />
                  <div className="flex flex-col">
                    <span>{publishActionLabel}</span>
                    <span className="text-xs text-muted-foreground">
                      Shared on the public hub
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleSaveToCloud(false)}>
                  <CloudIcon />
                  <div className="flex flex-col">
                    <span>{draftActionLabel}</span>
                    <span className="text-xs text-muted-foreground">
                      Private backup — not published
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
                  Collaborate
                </Button>
                {CollabDot}
              </span>
            </TooltipTrigger>
            <TooltipContent>Collaborate live on this lesson</TooltipContent>
          </Tooltip>
        </div>

        <NavActions current="editor" />
      </AppHeader>

      <div className="mx-auto max-w-3xl px-4 pt-6">
        <div className="rounded-panel border border-border bg-card p-4 text-card-foreground shadow-(--shadow-panel) sm:p-6">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Document title
          </p>
          <LiveInput
            value={doc.title}
            onCommit={setTitle}
            placeholder="Untitled Lesson"
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
                aria-label="Age range"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any age</SelectItem>
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
                  Suggest ideas
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Get AI lesson ideas tailored to this age range
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {sectionCount} section{sectionCount === 1 ? "" : "s"} · {blockCount}{" "}
            content block
            {blockCount === 1 ? "" : "s"}
          </p>

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
                        ? "Editing a published lesson"
                        : "Editing a cloud draft"}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {editingPublished
                      ? "You're editing a lesson you published. Saving to the cloud overwrites it in the hub. This status is saved until you update it or fork into a new lesson."
                      : "You're editing a draft backed up to the cloud. Only you can see it; saving updates the backup, or you can publish it to the hub. This status is saved until you change it or fork into a new lesson."}
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
                          ? `${git.pending} unsaved change${git.pending === 1 ? "" : "s"}`
                          : git.lastCommit
                            ? `Version saved ${timeAgo(git.lastCommit.at)}`
                            : "Version history"}
                      </Badge>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Every version of this lesson is saved automatically as you
                    work. Click to browse them and go back to any one.
                  </TooltipContent>
                </Tooltip>
              )}

              {editingId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={handleFork}>
                      <GitForkIcon data-icon="inline-start" />
                      Fork into a new lesson
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Detach from this saved lesson and start a new one. The new
                    lesson keeps this one&rsquo;s history, so you can merge them
                    later. Saving to the cloud will create a separate copy
                    instead of overwriting the original.
                  </TooltipContent>
                </Tooltip>
              )}

              {/* This lesson is a fork. Offer to pull in whatever the original
                  has changed since — merged block by block. */}
              {forkedFrom && gitRemoteEnabled && (
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
                        ? "Checking..."
                        : `Sync with ${forkedFromTitle || "the original"}`}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Bring in the changes made to{" "}
                    {forkedFromTitle || "the original lesson"} since you forked
                    it. Edits to different blocks — or to different parts of the
                    same block — merge automatically; anything genuinely
                    clashing is put to you.
                  </TooltipContent>
                </Tooltip>
              )}

              {/* We're a trusted collaborator on the lesson this was forked from,
                  so we can merge our work back INTO it — the contribution flow.
                  Anyone else can fork and sync, but only push their own copy. */}
              {forkedFrom && canContribute && gitRemoteEnabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      onClick={handleContribute}
                      disabled={busy !== null}
                    >
                      <GitPullRequestIcon data-icon="inline-start" />
                      {busy === "contribute"
                        ? "Merging..."
                        : `Merge back into ${forkedFromTitle || "the original"}`}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    You&rsquo;re a trusted collaborator on{" "}
                    {forkedFromTitle || "the original lesson"}, so you can merge
                    your changes back into it. Its latest changes are pulled in
                    first, block by block, and only genuine clashes are put to
                    you. Its author is notified.
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
                  <p className="mb-1 text-lg font-semibold">No sections yet</p>
                  <p className="mb-4 text-sm text-muted-foreground">
                    Tap the <strong>+</strong> button to create your first
                    lesson section.
                  </p>
                  <div className="flex flex-col justify-center gap-3 sm:flex-row">
                    <Button onClick={openAddDialog}>
                      <PlusIcon data-icon="inline-start" />
                      Add section
                    </Button>
                    <Button
                      variant="outline"
                      onClick={openImportWarning}
                      disabled={busy !== null}
                    >
                      <FileUpIcon data-icon="inline-start" />
                      Import Word document
                    </Button>
                    <Button
                      variant="outline"
                      onClick={triggerJsonImportPicker}
                      disabled={busy !== null}
                    >
                      <BracesIcon data-icon="inline-start" />
                      Import JSON
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
            aria-label="add section"
            className="fixed right-4 bottom-4 z-40 size-14 rounded-full shadow-[var(--shadow-panel)] sm:right-8 sm:bottom-8"
          >
            <PlusIcon className="size-6" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add section</TooltipContent>
      </Tooltip>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>New section</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="new-section-name" className="sr-only">
              Section name
            </FieldLabel>
            <Input
              id="new-section-name"
              autoFocus
              placeholder={`Section ${sectionCount + 1}`}
              value={newSectionName}
              onChange={(e) => setNewSectionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmAddSection();
              }}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmAddSection}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(previewContent)}
        onOpenChange={(next) => !next && setPreviewContent(null)}
      >
        <DialogContent className="flex max-h-[90vh] w-full flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Preview</DialogTitle>
          </DialogHeader>
          <div
            className="s2c-preview-root overflow-y-auto rounded-md border border-border bg-white p-4 text-[#1a1a1a]"
            dangerouslySetInnerHTML={{
              __html: `<style>${PREVIEW_STYLES}</style>${previewContent || ""}`,
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewContent(null)}>
              Close
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
            <DialogTitle>Replace your current work?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {pendingEdit?.mode === "fork"
              ? "Forking "
              : pendingEdit?.mode === "import"
                ? "Importing "
                : "Opening "}
            <strong>{pendingEdit?.title || "this lesson"}</strong>
            {pendingEdit?.mode === "edit" ? " for editing" : ""} will replace
            the lesson you&rsquo;re working on now. Your in-progress work is
            auto-saved in this browser, and replacing it can&rsquo;t be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingEdit(null)}>
              Keep my work
            </Button>
            <Button
              variant="destructive"
              onClick={() => applyEdit(pendingEdit)}
            >
              {pendingEdit?.mode === "fork"
                ? "Replace and fork"
                : pendingEdit?.mode === "import"
                  ? "Replace and import"
                  : "Replace and edit"}
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
            <DialogTitle>Import a Word document</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              Importing a <strong className="text-foreground">.docx</strong>{" "}
              file is{" "}
              <strong className="text-foreground">best-effort and lossy</strong>
              . It works best with documents exported from this app; files
              written elsewhere may import poorly or not at all.
            </p>
            <p>
              For the import to work, the document must use{" "}
              <strong className="text-foreground">Heading 2</strong> styles for
              its section headings. Images, colours, and exact formatting may be
              lost.
            </p>
            <p>
              If the document isn&rsquo;t structured as a lesson, it won&rsquo;t
              be opened. Your current work is replaced only after you confirm.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportWarnOpen(false)}>
              Cancel
            </Button>
            <Button onClick={triggerImportPicker}>
              <FileUpIcon data-icon="inline-start" />
              Choose file
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
              Couldn&rsquo;t import this document
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{importError}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportError(null)}>
              Close
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
              Try another file
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
            ? "the saved lesson"
            : forkedFromTitle || "the original"
        }
        onConfirm={confirmMerge}
        busy={merging}
      />

      {/* Floating avatars showing where each collaborator is editing. */}
      <CollabCursors selections={collab.selections} />

      {/* Floating live-chat panel, pinned to the bottom-left while collaborating. */}
      <CollabChat collab={collab} />

      {editLoading && (
        <div className="fixed inset-0 z-(--z-overlay) flex items-center justify-center bg-black/50">
          <Spinner className="size-10 text-white" />
        </div>
      )}

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {toast ? (
          <MuiAlert
            severity={toast.severity}
            onClose={() => setToast(null)}
            variant="filled"
            action={
              toast.link ? (
                <MuiButton
                  color="inherit"
                  size="small"
                  href={toast.link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {toast.link.label}
                </MuiButton>
              ) : toast.route ? (
                <MuiButton
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setToast(null);
                    navigate(toast.route.to);
                  }}
                >
                  {toast.route.label}
                </MuiButton>
              ) : undefined
            }
          >
            {toast.message}
          </MuiAlert>
        ) : undefined}
      </Snackbar>
    </div>
  );
}
