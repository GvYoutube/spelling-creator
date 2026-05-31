import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import AddIcon from "@mui/icons-material/Add";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import SaveIcon from "@mui/icons-material/Save";
import DescriptionIcon from "@mui/icons-material/Description";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import AddToDriveIcon from "@mui/icons-material/AddToDrive";
import VisibilityIcon from "@mui/icons-material/Visibility";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import SpellcheckIcon from "@mui/icons-material/Spellcheck";
import GroupsIcon from "@mui/icons-material/Groups";
import IosShareIcon from "@mui/icons-material/IosShare";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import GitHubIcon from "@mui/icons-material/GitHub";
import Badge from "@mui/material/Badge";
import SectionCard from "../components/SectionCard.jsx";
import NavActions from "../components/NavActions.jsx";
import CollaborateDialog from "../components/CollaborateDialog.jsx";
import CollabCursors from "../components/CollabCursors.jsx";
import FirstLessonWizard from "../components/FirstLessonWizard.jsx";
import { newId } from "../lib/id.js";
import { extractCapitalizedWords } from "../lib/spelling.js";
import {
  loadDocument,
  saveDocument,
  loadEditingId,
  saveEditingId,
  loadWizardSeen,
  saveWizardSeen,
} from "../lib/storage.js";
import { exportDocx } from "../lib/docxExport.js";
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

function createInitialDoc() {
  return loadDocument() || { title: "Put your topic here...", sections: [] };
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
  const [doc, setDoc] = useState(createInitialDoc);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [busy, setBusy] = useState(null); // 'docx' | 'pdf' | 'gdocs' | 'preview' | 'publish' | null
  const [toast, setToast] = useState(null); // { severity, message }
  const [previewContent, setPreviewContent] = useState(null); // HTML string | null
  const [exportAnchor, setExportAnchor] = useState(null); // export dropdown anchor el | null
  const [mobileMenuAnchor, setMobileMenuAnchor] = useState(null); // overflow menu anchor on small screens | null

  // Hub-editing state. `editingId` is the id of a published lesson currently
  // loaded for editing (so "Publish" becomes "Update"); null when authoring a
  // fresh lesson. It's persisted to localStorage (see effect below) so the
  // status survives reloads and tab closes until the user overwrites it (by
  // opening another published lesson) or forks into a new lesson.
  // `pendingEdit` holds a fetched lesson awaiting the user's confirmation to
  // overwrite their in-progress work; `editLoading` covers the fetch of the
  // lesson to edit.
  const [editingId, setEditingId] = useState(loadEditingId);
  const [pendingEdit, setPendingEdit] = useState(null); // { id, title, doc } | null
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
  useEffect(() => {
    if (!loadWizardSeen()) setWizardOpen(true);
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
    saveDocument(doc);
  }, [doc]);

  // Persist the editing-published status so it survives reloads/tab closes.
  useEffect(() => {
    saveEditingId(editingId);
  }, [editingId]);

  // Adopt a fetched lesson into the editor: replace the working doc (this is the
  // step that overwrites the auto-saved draft). For an edit, enter edit mode so
  // "Publish" becomes "Update" on the original row. For a fork, load it as a
  // fresh, unattached draft (editingId stays null) titled "… (copy)", so
  // publishing creates a separate lesson and the original is left untouched.
  const applyEdit = ({ id, doc: nextDoc, mode }) => {
    if (mode === "fork") {
      setDoc({
        ...nextDoc,
        title: `${nextDoc.title || "Untitled Lesson"} (copy)`,
      });
      setEditingId(null);
      setPendingEdit(null);
      setToast({
        severity: "info",
        message:
          "Forked into a new lesson — edit freely, then Publish to add your copy to the hub.",
      });
      return;
    }
    setDoc(nextDoc);
    setEditingId(id);
    setPendingEdit(null);
    setToast({
      severity: "info",
      message:
        "Loaded your published lesson — edit and press Update to save it.",
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
    if (editRequestedRef.current) return;
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
  }, []);

  const setTitle = (title) => setDoc((d) => ({ ...d, title }));

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

  const handlePublish = async () => {
    if (doc.sections.length === 0) {
      setToast({
        severity: "warning",
        message: "Add at least one section before publishing.",
      });
      return;
    }
    // Publishing requires a signed-in account — send the user to the login page
    // (and back) if they aren't authenticated yet.
    if (!accessToken) {
      setToast({
        severity: "info",
        message: "Please sign in to publish a lesson to the hub.",
      });
      navigate("/login");
      return;
    }
    setBusy("publish");
    try {
      const lesson = await publishLesson(doc, accessToken);
      // Enter edit mode for the lesson we just created, so a further "Publish"
      // updates this row instead of creating a duplicate.
      if (lesson?.id) setEditingId(lesson.id);
      setToast({
        severity: "success",
        message: "Lesson published to the hub.",
        route: { to: "/hub", label: "View hub" },
      });
    } catch (err) {
      console.error(err);
      setToast({
        severity: "error",
        message: `Could not publish: ${err.message || err}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const handleUpdate = async () => {
    if (doc.sections.length === 0) {
      setToast({
        severity: "warning",
        message: "Add at least one section before saving.",
      });
      return;
    }
    if (!accessToken) {
      setToast({
        severity: "info",
        message: "Please sign in to update your published lesson.",
      });
      navigate("/login");
      return;
    }
    setBusy("publish");
    try {
      await updateLesson(editingId, doc, accessToken);
      setToast({
        severity: "success",
        message: "Lesson updated in the hub.",
        route: { to: "/hub", label: "View hub" },
      });
    } catch (err) {
      console.error(err);
      setToast({
        severity: "error",
        message: `Could not update: ${err.message || err}`,
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
    setToast({
      severity: "info",
      message:
        "Forked into a new lesson — publishing will create a separate copy in the hub.",
    });
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
                        editingId ? handleUpdate() : handlePublish();
                      }}
                      disabled={busy !== null}
                    >
                      <ListItemIcon>
                        {editingId ? (
                          <SaveIcon fontSize="small" />
                        ) : (
                          <CloudUploadIcon fontSize="small" />
                        )}
                      </ListItemIcon>
                      <ListItemText>
                        {editingId ? "Update lesson" : "Publish to hub"}
                      </ListItemText>
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
                {lessonHubEnabled && authEnabled && (
                  <Button
                    color="inherit"
                    variant="outlined"
                    startIcon={
                      busy === "publish" ? (
                        <CircularProgress size={16} color="inherit" />
                      ) : editingId ? (
                        <SaveIcon />
                      ) : (
                        <CloudUploadIcon />
                      )
                    }
                    onClick={editingId ? handleUpdate : handlePublish}
                    disabled={busy !== null}
                    sx={inheritBorder}
                  >
                    {editingId ? "Update lesson" : "Publish to hub"}
                  </Button>
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
              <Tooltip title="You're editing a lesson you published. Updating overwrites it in the hub. This status is saved until you update it or fork into a new lesson.">
                <Chip
                  size="small"
                  color="primary"
                  variant="outlined"
                  icon={<CloudUploadIcon />}
                  label="Editing a published lesson"
                />
              </Tooltip>
              <Tooltip title="Detach from the published lesson and start a new one. Publishing will then create a separate copy instead of overwriting the original.">
                <Button
                  size="small"
                  variant="text"
                  startIcon={<CallSplitIcon />}
                  onClick={handleFork}
                >
                  Fork from published lesson
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
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={openAddDialog}
            >
              Add section
            </Button>
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
            {pendingEdit?.mode === "fork" ? "Forking" : "Opening"}{" "}
            <strong>{pendingEdit?.title || "this lesson"}</strong>
            {pendingEdit?.mode === "fork" ? "" : " for editing"} will replace
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
              : "Replace and edit"}
          </Button>
        </DialogActions>
      </Dialog>

      <FirstLessonWizard open={wizardOpen} onClose={closeWizard} />

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
