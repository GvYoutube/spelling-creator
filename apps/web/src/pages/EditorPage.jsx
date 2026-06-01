import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useDocumentMeta } from "../lib/seo.js";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Paper from "@mui/material/Paper";
import Fab from "@mui/material/Fab";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import Chip from "@mui/material/Chip";
import Backdrop from "@mui/material/Backdrop";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import AddIcon from "@mui/icons-material/Add";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import DescriptionIcon from "@mui/icons-material/Description";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import AddToDriveIcon from "@mui/icons-material/AddToDrive";
import VisibilityIcon from "@mui/icons-material/Visibility";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import CloudIcon from "@mui/icons-material/Cloud";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import SpellcheckIcon from "@mui/icons-material/Spellcheck";
import GroupsIcon from "@mui/icons-material/Groups";
import IosShareIcon from "@mui/icons-material/IosShare";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import GitHubIcon from "@mui/icons-material/GitHub";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Badge from "@mui/material/Badge";
import SectionCard from "../components/SectionCard.jsx";
import NavActions from "../components/NavActions.jsx";
import CollaborateDialog from "../components/CollaborateDialog.jsx";
import CollabCursors from "../components/CollabCursors.jsx";
import FirstLessonWizard from "../components/FirstLessonWizard.jsx";
import AiLessonIdeaDialog from "../components/AiLessonIdeaDialog.jsx";
import { AGE_RANGES } from "../lib/ageRanges.js";
import { newId } from "../lib/id.js";
import { extractCapitalizedWords } from "../lib/spelling.js";
import {
  loadDocument,
  saveDocument,
  loadEditingId,
  saveEditingId,
  loadEditingPublished,
  saveEditingPublished,
  loadWizardSeen,
  saveWizardSeen,
  migrateLocalStorage,
} from "../lib/storage.js";
import { convertDocImages } from "../lib/imageRef.js";
import { ensureImagesUploaded } from "../lib/imagesClient.js";
import { exportDocx } from "../lib/docxExport.js";
import { importDocxFile } from "../lib/docxImport.js";
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

const inheritBorder = { borderColor: "rgba(255,255,255,0.6)" };

export default function EditorPage() {
  useDocumentMeta();
  const [doc, setDoc] = useState(createInitialDoc);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [ideaDialogOpen, setIdeaDialogOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [busy, setBusy] = useState(null); // 'docx' | 'pdf' | 'gdocs' | 'preview' | 'publish' | 'import' | null
  const [toast, setToast] = useState(null); // { severity, message }
  const [previewContent, setPreviewContent] = useState(null); // HTML string | null
  const [exportAnchor, setExportAnchor] = useState(null); // export dropdown anchor el | null
  const [cloudAnchor, setCloudAnchor] = useState(null); // "Save to cloud" dropdown anchor el | null
  const [mobileMenuAnchor, setMobileMenuAnchor] = useState(null); // overflow menu anchor on small screens | null
  // Word-import flow. `importWarnOpen` shows the "import is best-effort" warning
  // before the file picker; `importError` holds the reason a chosen file was
  // rejected (shown in a dialog — the editor is left untouched). The hidden
  // file input is triggered programmatically from the warning dialog.
  const [importWarnOpen, setImportWarnOpen] = useState(false);
  const [importError, setImportError] = useState(null);
  const importInputRef = useRef(null);

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

  const { enabled: authEnabled, accessToken, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const theme = useTheme();
  // Below "md" the toolbar can't fit all the action buttons, so they collapse
  // into a single overflow menu.
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

  const closeMobileMenu = () => setMobileMenuAnchor(null);
  const showPublish = lessonHubEnabled && authEnabled;

  // Real-time collaboration over PeerJS. The hook watches `doc` to broadcast
  // local edits and calls setDoc with documents received from collaborators.
  // Identity is shared as presence so collaborators see who's in the lesson.
  const identity = useMemo(
    () => ({
      name:
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
  const collab = useCollaboration({ doc, onRemoteDoc: setDoc, identity });
  const [collabOpen, setCollabOpen] = useState(false);

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
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await migrateLocalStorage();
      const [savedDoc, savedEditingId, savedPublished, seen] =
        await Promise.all([
          loadDocument(),
          loadEditingId(),
          loadEditingPublished(),
          loadWizardSeen(),
        ]);
      if (cancelled) return;
      if (savedDoc) setDoc(savedDoc);
      if (savedEditingId) setEditingId(savedEditingId);
      setEditingPublished(savedPublished);
      if (!seen) setWizardOpen(true);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    if (hydrated) saveDocument(doc);
  }, [doc, hydrated]);

  // Persist the editing-published status so it survives reloads/tab closes.
  useEffect(() => {
    if (hydrated) saveEditingId(editingId);
  }, [editingId, hydrated]);

  // Persist whether the edited lesson is published or a draft. Clear it when no
  // lesson is attached, so a fresh document defaults back to "publish".
  useEffect(() => {
    if (hydrated) saveEditingPublished(editingId ? editingPublished : null);
  }, [editingId, editingPublished, hydrated]);

  // Adopt a fetched lesson into the editor: replace the working doc (this is the
  // step that overwrites the auto-saved draft). For an edit, enter edit mode so
  // "Publish" becomes "Update" on the original row. For a fork, load it as a
  // fresh, unattached draft (editingId stays null) titled "… (copy)", so
  // publishing creates a separate lesson and the original is left untouched.
  const applyEdit = ({ id, doc: nextDoc, mode, published }) => {
    if (mode === "import") {
      // An imported Word doc loads as a fresh, unattached lesson (like a fork,
      // but keeping the document's own title): saving it later creates a new
      // cloud lesson rather than overwriting anything.
      setDoc(nextDoc);
      setEditingId(null);
      setEditingPublished(true);
      setPendingEdit(null);
      setToast({
        severity: "info",
        message:
          "Imported from Word. Word import is best-effort — review the lesson, as some formatting or content may have been lost.",
      });
      return;
    }
    if (mode === "fork") {
      setDoc({
        ...nextDoc,
        title: `${nextDoc.title || "Untitled Lesson"} (copy)`,
      });
      setEditingId(null);
      setEditingPublished(true);
      setPendingEdit(null);
      setToast({
        severity: "info",
        message:
          "Forked into a new lesson — edit freely, then save it to the cloud as your own copy.",
      });
      return;
    }
    setDoc(nextDoc);
    setEditingId(id);
    setEditingPublished(published);
    setPendingEdit(null);
    setToast({
      severity: "info",
      message: published
        ? "Loaded your published lesson — edit and save to the cloud to update it."
        : "Loaded your draft — edit and save to the cloud, or publish it to the hub.",
    });
  };

  // The hub asks us to edit one of the user's lessons — and the lesson page asks
  // us to fork any lesson — by stashing its id in sessionStorage (see
  // HubPage/LessonPage) and navigating here. Consume that request once on mount:
  // read and clear the key, fetch the full lesson, then either load it straight
  // away (when there's no in-progress work to lose) or ask before clobbering the
  // current draft. A one-shot ref guards against StrictMode's dev-only
  // double-mount; clearing the key also stops a reload from reloading it.
  useEffect(() => {
    // Wait until the saved draft has hydrated, so the "is there work to lose?"
    // check below sees the real document rather than the empty starter.
    if (!hydrated || editRequestedRef.current) return;
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
    fetchLesson(lessonId)
      .then((lesson) => {
        const incoming = {
          id: lesson.id,
          title: lesson.title,
          doc: lesson.doc,
          mode,
          // Drafts (published === false) load with their draft status preserved so
          // a re-save keeps them private until the author chooses to publish.
          published: lesson.published !== false,
        };
        // Edit can adopt straight away when re-opening the same lesson; either
        // mode adopts when there's no in-progress work to lose. Otherwise warn.
        if (
          (mode === "edit" && editingIdRef.current === lesson.id) ||
          !docHasContent(docRef.current)
        ) {
          applyEdit(incoming);
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
  }, [hydrated]);

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

  const updateSection = (id, next) =>
    setDoc((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.id === id ? next : s)),
    }));

  const deleteSection = (id) =>
    setDoc((d) => ({ ...d, sections: d.sections.filter((s) => s.id !== id) }));

  const moveSection = (from, to) => {
    if (to < 0) return;
    setDoc((d) => {
      if (to >= d.sections.length) return d;
      const sections = [...d.sections];
      const [moved] = sections.splice(from, 1);
      sections.splice(to, 0, moved);
      return { ...d, sections };
    });
  };

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
    setCloudAnchor(null);
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
      if (editingId) {
        await updateLesson(editingId, converted, accessToken, {
          published: publish,
        });
      } else {
        const lesson = await publishLesson(converted, accessToken, {
          published: publish,
        });
        if (lesson?.id) setEditingId(lesson.id);
      }
      setEditingPublished(publish);
      setToast({
        severity: "success",
        message: publish
          ? "Lesson published to the hub."
          : "Draft saved to the cloud — only you can see it.",
        route: publish ? { to: "/hub", label: "View hub" } : undefined,
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
  const handleFork = () => {
    setEditingId(null);
    setEditingPublished(true);
    setToast({
      severity: "info",
      message:
        "Forked into a new lesson — saving to the cloud will create a separate copy.",
    });
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
      const incoming = { doc: imported, title: imported.title, mode: "import" };
      if (docHasContent(doc)) setPendingEdit(incoming);
      else applyEdit(incoming);
    } catch (err) {
      setImportError(
        err?.message ||
          "This Word document couldn't be imported. Please check it and try again.",
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
  // block's "fill" button, so it can populate the list from the passage.
  const capitalizedWords = useMemo(() => extractCapitalizedWords(doc), [doc]);

  const [anchorEl, setAnchorEl] = useState(null);
  const menuOpen = Boolean(anchorEl);

  // "Save to cloud" menu labels adapt to whether a lesson is already attached
  // (editingId) and, if so, whether it's currently published or a draft — so each
  // action reads as either creating, updating, or switching the lesson's state.
  const publishActionLabel =
    editingId && editingPublished
      ? "Update published lesson"
      : "Publish to hub";
  const draftActionLabel =
    editingId && !editingPublished ? "Update draft" : "Save as draft";

  return (
    <Box sx={{ minHeight: "100vh", pb: 12 }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          <Tooltip title="Account">
            <IconButton
              color="inherit"
              onClick={(e) => setAnchorEl(e.currentTarget)}
              aria-label="logo"
            >
              <SpellcheckIcon sx={{ mr: 1.5, flexShrink: 0 }} />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={anchorEl}
            open={menuOpen}
            onClose={() => setAnchorEl(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <MenuItem
              onClick={() => {
                setAnchorEl(null);
                openImportWarning();
              }}
              disabled={busy !== null}
            >
              <UploadFileIcon sx={{ mr: 1, fontSize: 20 }} />
              Import Word document
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                setAnchorEl(null);
                window.open(
                  "https://github.com/playforge-coding/spelling-creator",
                  "_blank",
                );
              }}
            >
              <GitHubIcon sx={{ mr: 1, fontSize: 20 }} />
              GitHub
            </MenuItem>
          </Menu>
          <Typography
            variant="h6"
            noWrap
            sx={{ flexGrow: 1, minWidth: 0, mr: 1 }}
          >
            Spelling Lesson Maker
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            {isMobile && (
              <>
                <Tooltip title="Lesson actions">
                  <IconButton
                    color="inherit"
                    onClick={(e) => setMobileMenuAnchor(e.currentTarget)}
                    aria-label="lesson actions"
                  >
                    <Badge
                      color="success"
                      badgeContent={
                        collab.active ? collab.participants.length : 0
                      }
                      overlap="circular"
                    >
                      <MoreVertIcon />
                    </Badge>
                  </IconButton>
                </Tooltip>
                <Tooltip title="How to create a lesson">
                  <IconButton
                    color="inherit"
                    onClick={openWizard}
                    aria-label="how to create a lesson"
                  >
                    <HelpOutlineIcon />
                  </IconButton>
                </Tooltip>
                <Menu
                  anchorEl={mobileMenuAnchor}
                  open={Boolean(mobileMenuAnchor)}
                  onClose={closeMobileMenu}
                  anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                  transformOrigin={{ vertical: "top", horizontal: "right" }}
                >
                  <MenuItem
                    onClick={() => {
                      closeMobileMenu();
                      handlePreview();
                    }}
                    disabled={busy !== null}
                  >
                    <ListItemIcon>
                      <VisibilityIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Preview</ListItemText>
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      closeMobileMenu();
                      openImportWarning();
                    }}
                    disabled={busy !== null}
                  >
                    <ListItemIcon>
                      <UploadFileIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Import Word document</ListItemText>
                  </MenuItem>
                  <Divider />
                  <MenuItem
                    onClick={() => {
                      closeMobileMenu();
                      handleExport("docx");
                    }}
                    disabled={busy !== null}
                  >
                    <ListItemIcon>
                      <DescriptionIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Export DOCX</ListItemText>
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      closeMobileMenu();
                      handleExport("pdf");
                    }}
                    disabled={busy !== null}
                  >
                    <ListItemIcon>
                      <PictureAsPdfIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Print PDF</ListItemText>
                  </MenuItem>
                  {googleDriveEnabled && (
                    <MenuItem
                      onClick={() => {
                        closeMobileMenu();
                        handleSaveToGoogle();
                      }}
                      disabled={busy !== null}
                    >
                      <ListItemIcon>
                        <AddToDriveIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText>Save to Google Docs</ListItemText>
                    </MenuItem>
                  )}
                  {showPublish && <Divider />}
                  {showPublish && (
                    <MenuItem
                      onClick={() => {
                        closeMobileMenu();
                        handleSaveToCloud(true);
                      }}
                      disabled={busy !== null}
                    >
                      <ListItemIcon>
                        <CloudUploadIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText>{publishActionLabel}</ListItemText>
                    </MenuItem>
                  )}
                  {showPublish && (
                    <MenuItem
                      onClick={() => {
                        closeMobileMenu();
                        handleSaveToCloud(false);
                      }}
                      disabled={busy !== null}
                    >
                      <ListItemIcon>
                        <CloudQueueIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText>{draftActionLabel}</ListItemText>
                    </MenuItem>
                  )}
                  <Divider />
                  <MenuItem
                    onClick={() => {
                      closeMobileMenu();
                      setCollabOpen(true);
                    }}
                  >
                    <ListItemIcon>
                      <GroupsIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>
                      {collab.active
                        ? `Collaborating (${collab.participants.length})`
                        : "Collaborate"}
                    </ListItemText>
                  </MenuItem>
                </Menu>
              </>
            )}
            {!isMobile && (
              <>
                <Tooltip title="How to create a lesson">
                  <IconButton
                    color="inherit"
                    onClick={openWizard}
                    aria-label="how to create a lesson"
                  >
                    <HelpOutlineIcon />
                  </IconButton>
                </Tooltip>
                <Button
                  color="inherit"
                  variant="outlined"
                  startIcon={
                    busy === "preview" ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <VisibilityIcon />
                    )
                  }
                  onClick={handlePreview}
                  disabled={busy !== null}
                  sx={inheritBorder}
                >
                  Preview
                </Button>
                <Button
                  color="inherit"
                  variant="outlined"
                  startIcon={
                    busy === "docx" || busy === "pdf" || busy === "gdocs" ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <IosShareIcon />
                    )
                  }
                  endIcon={<ArrowDropDownIcon />}
                  onClick={(e) => setExportAnchor(e.currentTarget)}
                  disabled={busy !== null}
                  sx={inheritBorder}
                >
                  Export
                </Button>
                <Menu
                  anchorEl={exportAnchor}
                  open={Boolean(exportAnchor)}
                  onClose={() => setExportAnchor(null)}
                  anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                  transformOrigin={{ vertical: "top", horizontal: "right" }}
                >
                  <MenuItem
                    onClick={() => {
                      setExportAnchor(null);
                      handleExport("docx");
                    }}
                  >
                    <ListItemIcon>
                      <DescriptionIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Export DOCX</ListItemText>
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      setExportAnchor(null);
                      handleExport("pdf");
                    }}
                  >
                    <ListItemIcon>
                      <PictureAsPdfIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Print PDF</ListItemText>
                  </MenuItem>
                  {googleDriveEnabled && (
                    <MenuItem
                      onClick={() => {
                        setExportAnchor(null);
                        handleSaveToGoogle();
                      }}
                    >
                      <ListItemIcon>
                        <AddToDriveIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText>Save to Google Docs</ListItemText>
                    </MenuItem>
                  )}
                </Menu>
                {showPublish && (
                  <>
                    <Button
                      color="inherit"
                      variant="outlined"
                      startIcon={
                        busy === "publish" ? (
                          <CircularProgress size={16} color="inherit" />
                        ) : (
                          <CloudIcon />
                        )
                      }
                      endIcon={<ArrowDropDownIcon />}
                      onClick={(e) => setCloudAnchor(e.currentTarget)}
                      disabled={busy !== null}
                      sx={inheritBorder}
                    >
                      Save to cloud
                    </Button>
                    <Menu
                      anchorEl={cloudAnchor}
                      open={Boolean(cloudAnchor)}
                      onClose={() => setCloudAnchor(null)}
                      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                      transformOrigin={{ vertical: "top", horizontal: "right" }}
                    >
                      <MenuItem onClick={() => handleSaveToCloud(true)}>
                        <ListItemIcon>
                          <CloudUploadIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText
                          primary={publishActionLabel}
                          secondary="Shared on the public hub"
                        />
                      </MenuItem>
                      <MenuItem onClick={() => handleSaveToCloud(false)}>
                        <ListItemIcon>
                          <CloudQueueIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText
                          primary={draftActionLabel}
                          secondary="Private backup — not published"
                        />
                      </MenuItem>
                    </Menu>
                  </>
                )}
                <Tooltip title="Collaborate live on this lesson">
                  <Badge
                    color="success"
                    badgeContent={
                      collab.active ? collab.participants.length : 0
                    }
                    overlap="circular"
                  >
                    <Button
                      color="inherit"
                      variant={collab.active ? "contained" : "outlined"}
                      startIcon={<GroupsIcon />}
                      onClick={() => setCollabOpen(true)}
                      sx={collab.active ? undefined : inheritBorder}
                    >
                      Collaborate
                    </Button>
                  </Badge>
                </Tooltip>
              </>
            )}
            <NavActions current="editor" />
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ pt: 3 }}>
        <Paper elevation={2} sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
          <Typography variant="overline" color="text.secondary">
            Document title
          </Typography>
          <TextField
            fullWidth
            variant="standard"
            placeholder="Untitled Lesson"
            value={doc.title}
            onChange={(e) => setTitle(e.target.value)}
            slotProps={{
              input: { sx: { fontSize: 28, fontWeight: 700 } },
              htmlInput: { "data-collab-field": "doc:title" },
            }}
          />
          <Stack
            direction="row"
            spacing={1.5}
            alignItems="center"
            flexWrap="wrap"
            useFlexGap
            sx={{ mt: 1.5 }}
          >
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="age-range-label">Age range</InputLabel>
              <Select
                labelId="age-range-label"
                label="Age range"
                value={doc.ageRange || ""}
                onChange={(e) => setAgeRange(e.target.value)}
              >
                <MenuItem value="">
                  <em>Any age</em>
                </MenuItem>
                {AGE_RANGES.map((range) => (
                  <MenuItem key={range} value={range}>
                    {range}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Tooltip title="Get AI lesson ideas tailored to this age range">
              <Button
                size="small"
                variant="outlined"
                startIcon={<AutoAwesomeIcon />}
                onClick={() => setIdeaDialogOpen(true)}
              >
                Suggest ideas
              </Button>
            </Tooltip>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {sectionCount} section{sectionCount === 1 ? "" : "s"} · {blockCount}{" "}
            content block
            {blockCount === 1 ? "" : "s"}
          </Typography>
          {editingId && (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              flexWrap="wrap"
              useFlexGap
              sx={{ mt: 1.5 }}
            >
              <Tooltip
                title={
                  editingPublished
                    ? "You're editing a lesson you published. Saving to the cloud overwrites it in the hub. This status is saved until you update it or fork into a new lesson."
                    : "You're editing a draft backed up to the cloud. Only you can see it; saving updates the backup, or you can publish it to the hub. This status is saved until you change it or fork into a new lesson."
                }
              >
                <Chip
                  size="small"
                  color={editingPublished ? "primary" : "default"}
                  variant="outlined"
                  icon={
                    editingPublished ? <CloudUploadIcon /> : <CloudQueueIcon />
                  }
                  label={
                    editingPublished
                      ? "Editing a published lesson"
                      : "Editing a cloud draft"
                  }
                />
              </Tooltip>
              <Tooltip title="Detach from this saved lesson and start a new one. Saving to the cloud will then create a separate copy instead of overwriting the original.">
                <Button
                  size="small"
                  variant="text"
                  startIcon={<CallSplitIcon />}
                  onClick={handleFork}
                >
                  Fork into a new lesson
                </Button>
              </Tooltip>
            </Stack>
          )}
        </Paper>

        <Stack spacing={3}>
          {doc.sections.map((section, i) => (
            <SectionCard
              key={section.id}
              section={section}
              documentName={doc.title}
              index={i}
              onChange={(next) => updateSection(section.id, next)}
              onDelete={() => deleteSection(section.id)}
              onMoveUp={() => moveSection(i, i - 1)}
              onMoveDown={() => moveSection(i, i + 1)}
              isFirst={i === 0}
              isLast={i === sectionCount - 1}
              onError={(message) => setToast({ severity: "error", message })}
              capitalizedWords={capitalizedWords}
            />
          ))}
        </Stack>

        {sectionCount === 0 && (
          <Paper
            variant="outlined"
            sx={{ p: 6, textAlign: "center", borderStyle: "dashed", mt: 1 }}
          >
            <Typography variant="h6" gutterBottom>
              No sections yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Tap the <strong>+</strong> button to create your first lesson
              section.
            </Typography>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={1.5}
              justifyContent="center"
            >
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={openAddDialog}
              >
                Add section
              </Button>
              <Button
                variant="outlined"
                startIcon={<UploadFileIcon />}
                onClick={openImportWarning}
                disabled={busy !== null}
              >
                Import Word document
              </Button>
            </Stack>
          </Paper>
        )}
      </Container>

      <Tooltip title="Add section">
        <Fab
          color="primary"
          onClick={openAddDialog}
          sx={{
            position: "fixed",
            bottom: { xs: 16, sm: 32 },
            right: { xs: 16, sm: 32 },
          }}
          aria-label="add section"
        >
          <AddIcon />
        </Fab>
      </Tooltip>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>New section</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Section name"
            placeholder={`Section ${sectionCount + 1}`}
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmAddSection();
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={confirmAddSection}>
            Add
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(previewContent)}
        onClose={() => setPreviewContent(null)}
        fullWidth
        maxWidth="md"
        scroll="paper"
        fullScreen={isMobile}
      >
        <DialogTitle>Preview</DialogTitle>
        <DialogContent dividers>
          <Box
            className="s2c-preview-root"
            sx={{ bgcolor: "#fff", color: "#1a1a1a", p: 2 }}
            dangerouslySetInnerHTML={{
              __html: `<style>${PREVIEW_STYLES}</style>${previewContent || ""}`,
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreviewContent(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Overwrite warning: opening a published lesson for editing replaces the
          working doc (and its auto-saved draft). Confirm before discarding it. */}
      <Dialog
        open={Boolean(pendingEdit)}
        onClose={() => setPendingEdit(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Replace your current work?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {pendingEdit?.mode === "fork"
              ? "Forking "
              : pendingEdit?.mode === "import"
                ? "Importing "
                : "Opening "}
            <strong>{pendingEdit?.title || "this lesson"}</strong>
            {pendingEdit?.mode === "edit" ? " for editing" : ""} will replace
            the lesson you’re working on now. Your in-progress work is
            auto-saved in this browser, and replacing it can’t be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingEdit(null)}>Keep my work</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => applyEdit(pendingEdit)}
          >
            {pendingEdit?.mode === "fork"
              ? "Replace and fork"
              : pendingEdit?.mode === "import"
                ? "Replace and import"
                : "Replace and edit"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Hidden picker for Word import, triggered from the warning dialog. */}
      <input
        ref={importInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        hidden
        onChange={handleImportFile}
      />

      {/* Warn before importing: the docx → lesson conversion is best-effort. */}
      <Dialog
        open={importWarnOpen}
        onClose={() => setImportWarnOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Import a Word document</DialogTitle>
        <DialogContent>
          <Typography variant="body2" gutterBottom>
            Importing a <strong>.docx</strong> file is{" "}
            <strong>best-effort and lossy</strong>. It works best with documents
            exported from this app; files written elsewhere may import poorly or
            not at all.
          </Typography>
          <Typography variant="body2" gutterBottom>
            For the import to work, the document must use{" "}
            <strong>Heading 2</strong> styles for its section headings. Images,
            colours, and exact formatting may be lost, and answer lines for
            open-ended questions reset to the default.
          </Typography>
          <Typography variant="body2">
            If the document isn’t structured as a lesson, it won’t be opened.
            Your current work is replaced only after you confirm.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportWarnOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<UploadFileIcon />}
            onClick={triggerImportPicker}
          >
            Choose file
          </Button>
        </DialogActions>
      </Dialog>

      {/* Refusal: a readable file that isn't structured as a lesson. The editor
          is left untouched; we just explain why it couldn't be opened. */}
      <Dialog
        open={Boolean(importError)}
        onClose={() => setImportError(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <WarningAmberIcon color="warning" />
          Couldn’t import this document
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">{importError}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportError(null)}>Close</Button>
          <Button
            variant="contained"
            startIcon={<UploadFileIcon />}
            onClick={() => {
              setImportError(null);
              importInputRef.current?.click();
            }}
          >
            Try another file
          </Button>
        </DialogActions>
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

      {/* Floating avatars showing where each collaborator is editing. */}
      <CollabCursors selections={collab.selections} />

      <Backdrop open={editLoading} sx={{ zIndex: (t) => t.zIndex.modal + 1 }}>
        <CircularProgress color="inherit" />
      </Backdrop>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {toast ? (
          <Alert
            severity={toast.severity}
            onClose={() => setToast(null)}
            variant="filled"
            action={
              toast.link ? (
                <Button
                  color="inherit"
                  size="small"
                  href={toast.link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {toast.link.label}
                </Button>
              ) : toast.route ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setToast(null);
                    navigate(toast.route.to);
                  }}
                >
                  {toast.route.label}
                </Button>
              ) : undefined
            }
          >
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}
