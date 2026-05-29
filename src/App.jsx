import { useEffect, useMemo, useState } from "react";
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
import AddIcon from "@mui/icons-material/Add";
import DescriptionIcon from "@mui/icons-material/Description";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import SpellcheckIcon from "@mui/icons-material/Spellcheck";
import SectionCard from "./components/SectionCard.jsx";
import { newId } from "./lib/id.js";
import { loadDocument, saveDocument } from "./lib/storage.js";
import { exportDocx } from "./lib/docxExport.js";
import { exportPdf } from "./lib/pdfExport.js";

function createInitialDoc() {
  return loadDocument() || { title: "Put your topic here...", sections: [] };
}

export default function App() {
  const [doc, setDoc] = useState(createInitialDoc);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [busy, setBusy] = useState(null); // 'docx' | 'pdf' | null
  const [toast, setToast] = useState(null); // { severity, message }

  useEffect(() => {
    saveDocument(doc);
  }, [doc]);

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
          <Stack direction="row" spacing={1}>
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
              sx={{ borderColor: "rgba(255,255,255,0.6)" }}
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
              sx={{ borderColor: "rgba(255,255,255,0.6)" }}
            >
              Print PDF
            </Button>
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
          >
            {toast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}
