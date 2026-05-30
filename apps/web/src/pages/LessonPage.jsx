// A single lesson's own page, reachable at /hub/:id. This replaces the old hub
// preview dialog: opening a lesson now navigates here instead of popping a
// modal, so each lesson has a shareable URL. It fetches the full lesson by id,
// renders its document with the same docx→HTML preview pipeline the editor and
// export use, and shows the comments below. Authors get Edit/Delete here too.

import { useEffect, useState } from "react";
import {
  Link as RouterLink,
  useNavigate,
  useParams,
} from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Paper from "@mui/material/Paper";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import DialogContentText from "@mui/material/DialogContentText";
import TextField from "@mui/material/TextField";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import DescriptionIcon from "@mui/icons-material/Description";
import ForkRightIcon from "@mui/icons-material/ForkRight";
import NavActions from "../components/NavActions.jsx";
import CommentsSection from "../components/CommentsSection.jsx";
import {
  fetchLesson,
  deleteLesson,
  lessonHubEnabled,
  EDIT_REQUEST_KEY,
  FORK_REQUEST_KEY,
} from "../lib/lessons.js";
import { useAuth } from "../lib/auth.jsx";
import { previewHtml, PREVIEW_STYLES } from "../lib/htmlPreview.js";
import { exportDocx } from "../lib/docxExport.js";
import { exportPdf } from "../lib/pdfExport.js";

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
  const { id } = useParams();
  const { user, accessToken } = useAuth();
  const navigate = useNavigate();

  const [lesson, setLesson] = useState(null);
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Which export is in flight ('docx' | 'pdf' | null), plus a feedback toast.
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState("");

  // Delete-confirmation dialog. The user must retype the lesson's title to
  // confirm, guarding against an accidental, irreversible delete.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    if (!lessonHubEnabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setLesson(null);
    setHtml("");
    (async () => {
      try {
        const full = await fetchLesson(id);
        const rendered = await previewHtml(full.doc);
        if (cancelled) return;
        setLesson(full);
        setHtml(rendered);
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not open this lesson.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

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
    navigate("/");
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
    navigate("/");
  };

  // Export the lesson document — same pipeline the editor uses. 'docx' downloads
  // a Word file; 'pdf' opens the print dialog to save as PDF.
  const handleExport = async (kind) => {
    if (!lesson) return;
    setBusy(kind);
    try {
      if (kind === "docx") {
        await exportDocx(lesson.doc);
        setToast("Word document downloaded.");
      } else {
        await exportPdf(lesson.doc);
        setToast("PDF generated for printing.");
      }
    } catch (err) {
      setToast(`Export failed: ${err.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  // The title the user must type to confirm. Mirrors the fallback the hub and
  // backend use for an untitled lesson.
  const deleteTarget = lesson ? lesson.title || "Untitled Lesson" : "";
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
      await deleteLesson(id, accessToken);
      // Hand the hub a one-shot toast so the user gets feedback after we leave.
      navigate("/hub", { state: { deletedTitle: deleteTarget } });
    } catch (err) {
      setDeleteError(err.message || "Could not delete this lesson.");
      setDeleteBusy(false);
    }
  };

  const isAuthor =
    Boolean(user) && lesson?.authorId && lesson.authorId === user.id;

  return (
    <Box sx={{ minHeight: "100vh", pb: 8 }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          <Button
            color="inherit"
            component={RouterLink}
            to="/hub"
            startIcon={<ArrowBackIcon />}
            sx={{ mr: 1 }}
          >
            Lesson hub
          </Button>
          <Typography
            variant="h6"
            noWrap
            sx={{ flexGrow: 1, minWidth: 0 }}
            title={lesson?.title || ""}
          >
            {lesson?.title || "Lesson"}
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            {lesson && (
              <>
                <Button
                  color="inherit"
                  startIcon={
                    busy === "pdf" ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <PictureAsPdfIcon />
                    )
                  }
                  onClick={() => handleExport("pdf")}
                  disabled={Boolean(busy)}
                >
                  Print PDF
                </Button>
                <Button
                  color="inherit"
                  startIcon={
                    busy === "docx" ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <DescriptionIcon />
                    )
                  }
                  onClick={() => handleExport("docx")}
                  disabled={Boolean(busy)}
                >
                  Download Word
                </Button>
                <Button
                  color="inherit"
                  startIcon={<ForkRightIcon />}
                  onClick={forkLesson}
                  disabled={Boolean(busy)}
                >
                  Fork
                </Button>
              </>
            )}
            {isAuthor && (
              <>
                <Button
                  color="inherit"
                  startIcon={<EditIcon />}
                  onClick={editLesson}
                >
                  Edit
                </Button>
                <Button
                  color="inherit"
                  startIcon={<DeleteOutlineIcon />}
                  onClick={() => {
                    setDeleteText("");
                    setDeleteError("");
                    setDeleteOpen(true);
                  }}
                >
                  Delete
                </Button>
              </>
            )}
            <NavActions current="lesson" />
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ pt: 3 }}>
        {!lessonHubEnabled && (
          <Alert severity="info">
            The lesson hub is not configured (VITE_API_URL is missing).
          </Alert>
        )}

        {lessonHubEnabled && loading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
            <CircularProgress />
          </Box>
        )}

        {lessonHubEnabled && !loading && error && (
          <Alert
            severity="error"
            action={
              <Button
                color="inherit"
                size="small"
                component={RouterLink}
                to="/hub"
              >
                Back to hub
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        {lessonHubEnabled && !loading && !error && lesson && (
          <>
            <Stack sx={{ mb: 2 }}>
              <Typography variant="h4">
                {lesson.title || "Untitled Lesson"}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {lesson.author || "Anonymous"}
                {typeof lesson.sectionCount === "number"
                  ? ` · ${lesson.sectionCount} section${lesson.sectionCount === 1 ? "" : "s"}`
                  : ""}
                {lesson.createdAt ? ` · ${formatDate(lesson.createdAt)}` : ""}
              </Typography>
            </Stack>

            <Paper variant="outlined" sx={{ overflow: "hidden" }}>
              <Box
                className="s2c-preview-root"
                sx={{ bgcolor: "#fff", color: "#1a1a1a", p: 3 }}
                dangerouslySetInnerHTML={{
                  __html: `<style>${PREVIEW_STYLES}</style>${html}`,
                }}
              />
            </Paper>

            <Box sx={{ mt: 3 }}>
              <CommentsSection lessonId={lesson.id} />
            </Box>
          </>
        )}
      </Container>

      <Dialog open={deleteOpen} onClose={closeDelete} fullWidth maxWidth="xs">
        <DialogTitle>Delete this lesson?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            This permanently deletes <strong>{deleteTarget}</strong> from the
            hub. This can’t be undone. To confirm, type the lesson’s name below.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Lesson name"
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
          {deleteError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDelete} disabled={deleteBusy}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={confirmDelete}
            disabled={!deleteConfirmed || deleteBusy}
            startIcon={
              deleteBusy ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <DeleteOutlineIcon />
              )
            }
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast("")}
        message={toast}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Box>
  );
}
