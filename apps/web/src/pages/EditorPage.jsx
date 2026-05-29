import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import Chip from "@mui/material/Chip";
import Backdrop from "@mui/material/Backdrop";
import AddIcon from "@mui/icons-material/Add";
import SaveIcon from "@mui/icons-material/Save";
import DescriptionIcon from "@mui/icons-material/Description";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import AddToDriveIcon from "@mui/icons-material/AddToDrive";
import VisibilityIcon from "@mui/icons-material/Visibility";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import SpellcheckIcon from "@mui/icons-material/Spellcheck";
import SectionCard from "../components/SectionCard.jsx";
import NavActions from "../components/NavActions.jsx";
import { newId } from "../lib/id.js";
import { loadDocument, saveDocument } from "../lib/storage.js";
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
} from "../lib/lessons.js";
import { useAuth } from "../lib/auth.jsx";

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

  // Hub-editing state. `editingId` is the id of a published lesson currently
  // loaded for editing (so "Publish" becomes "Update"); null when authoring a
  // fresh lesson. `pendingEdit` holds a fetched lesson awaiting the user's
  // confirmation to overwrite their in-progress work; `editLoading` covers the
  // fetch of the lesson to edit.
  const [editingId, setEditingId] = useState(null);
  const [pendingEdit, setPendingEdit] = useState(null); // { id, title, doc } | null
  const [editLoading, setEditLoading] = useState(false);

  const { enabled: authEnabled, accessToken } = useAuth();
  const navigate = useNavigate();

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

  // Adopt a fetched lesson into the editor: replace the working doc (this is the
  // step that overwrites the auto-saved draft) and enter edit mode for it.
  const applyEdit = ({ id, doc: nextDoc }) => {
    setDoc(nextDoc);
    setEditingId(id);
    setPendingEdit(null);
    setToast({
      severity: "info",
      message: "Loaded your published lesson — edit and press Update to save it.",
    });
  };

  // The hub asks us to edit one of the user's lessons by stashing its id in
  // sessionStorage (see HubPage) and navigating here. Consume that request once
  // on mount: read and clear the key, fetch the full lesson, then either load it
  // straight away (when there's no in-progress work to lose) or ask before
  // clobbering the current draft. A one-shot ref guards against StrictMode's
  // dev-only double-mount; clearing the key also stops a reload from reloading it.
  useEffect(() => {
    if (editRequestedRef.current) return;
    let editLessonId = null;
    try {
      editLessonId = sessionStorage.getItem(EDIT_REQUEST_KEY);
    } catch {
      /* sessionStorage unavailable — nothing to load */
    }
    if (!editLessonId) return;
    editRequestedRef.current = true;
    try {
      sessionStorage.removeItem(EDIT_REQUEST_KEY);
    } catch {
      /* ignore */
    }

    setEditLoading(true);
    fetchLesson(editLessonId)
      .then((lesson) => {
        const incoming = { id: lesson.id, title: lesson.title, doc: lesson.doc };
        if (editingIdRef.current === lesson.id || !docHasContent(docRef.current)) {
          applyEdit(incoming);
        } else {
          setPendingEdit(incoming);
        }
      })
      .catch((err) => {
        setToast({
          severity: "error",
          message: err.message || "Could not open that lesson for editing.",
        });
      })
      .finally(() => setEditLoading(false));
  }, []);

  const setTitle = (title) => setDoc((d) => ({ ...d, title }));

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

  const sectionCount = doc.sections.length;
  const blockCount = useMemo(
    () => doc.sections.reduce((sum, s) => sum + s.blocks.length, 0),
    [doc.sections],
  );

  return (
    <Box sx={{ minHeight: "100vh", pb: 12 }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          <SpellcheckIcon sx={{ mr: 1.5 }} />
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Spelling Lesson Maker
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
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
                busy === "docx" ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <DescriptionIcon />
                )
              }
              onClick={() => handleExport("docx")}
              disabled={busy !== null}
              sx={inheritBorder}
            >
              Export DOCX
            </Button>
            <Button
              color="inherit"
              variant="outlined"
              startIcon={
                busy === "pdf" ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <PictureAsPdfIcon />
                )
              }
              onClick={() => handleExport("pdf")}
              disabled={busy !== null}
              sx={inheritBorder}
            >
              Print PDF
            </Button>
            {googleDriveEnabled && (
              <Button
                color="inherit"
                variant="outlined"
                startIcon={
                  busy === "gdocs" ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : (
                    <AddToDriveIcon />
                  )
                }
                onClick={handleSaveToGoogle}
                disabled={busy !== null}
                sx={inheritBorder}
              >
                Save to Google Docs
              </Button>
            )}
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
            <NavActions current="editor" />
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ pt: 3 }}>
        <Paper elevation={2} sx={{ p: 3, mb: 3 }}>
          <Typography variant="overline" color="text.secondary">
            Document title
          </Typography>
          <TextField
            fullWidth
            variant="standard"
            placeholder="Untitled Lesson"
            value={doc.title}
            onChange={(e) => setTitle(e.target.value)}
            slotProps={{ input: { sx: { fontSize: 28, fontWeight: 700 } } }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {sectionCount} section{sectionCount === 1 ? "" : "s"} · {blockCount}{" "}
            content block
            {blockCount === 1 ? "" : "s"}
          </Typography>
          {editingId && (
            <Tooltip title="You're editing a lesson you published. Updating overwrites it in the hub. Remove this to publish a new lesson instead.">
              <Chip
                size="small"
                color="primary"
                variant="outlined"
                icon={<CloudUploadIcon />}
                label="Editing a published lesson"
                onDelete={() => setEditingId(null)}
                sx={{ mt: 1.5 }}
              />
            </Tooltip>
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
          sx={{ position: "fixed", bottom: 32, right: 32 }}
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
            Opening{" "}
            <strong>{pendingEdit?.title || "this lesson"}</strong> for editing
            will replace the lesson you’re working on now. Your in-progress work
            is auto-saved in this browser, and replacing it can’t be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingEdit(null)}>Keep my work</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => applyEdit(pendingEdit)}
          >
            Replace and edit
          </Button>
        </DialogActions>
      </Dialog>

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
