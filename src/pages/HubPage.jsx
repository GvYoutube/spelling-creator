// Lesson hub — a public, read-only gallery of lessons other users have
// published. Summaries come from the Worker (GET /lessons); clicking a card
// fetches the full lesson and renders its document with the same docx→HTML
// preview pipeline the editor uses, so the hub view matches the export exactly.

import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Grid from "@mui/material/Grid2";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Paper from "@mui/material/Paper";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import IconButton from "@mui/material/IconButton";
import EditIcon from "@mui/icons-material/Edit";
import RefreshIcon from "@mui/icons-material/Refresh";
import NavActions from "../components/NavActions.jsx";
import CommentsSection from "../components/CommentsSection.jsx";
import { fetchPublishedLessons, fetchLesson, lessonHubEnabled } from "../lib/lessons.js";
import { previewHtml, PREVIEW_STYLES } from "../lib/htmlPreview.js";

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

export default function HubPage() {
  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // The lesson currently open in the viewer dialog, plus its rendered HTML.
  const [viewing, setViewing] = useState(null); // summary { id, title, ... } | null
  const [viewHtml, setViewHtml] = useState("");
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState("");

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

  useEffect(() => {
    if (lessonHubEnabled) load();
    else setLoading(false);
  }, []);

  const openLesson = async (summary) => {
    setViewing(summary);
    setViewHtml("");
    setViewError("");
    setViewLoading(true);
    try {
      const lesson = await fetchLesson(summary.id);
      const html = await previewHtml(lesson.doc);
      setViewHtml(html);
    } catch (err) {
      setViewError(err.message || "Could not open this lesson.");
    } finally {
      setViewLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: "100vh", pb: 8 }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          <Button
            color="inherit"
            component={RouterLink}
            to="/"
            startIcon={<EditIcon />}
            sx={{ mr: 1 }}
          >
            Editor
          </Button>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Lesson hub
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <NavActions current="hub" />
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ pt: 3 }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ mb: 2 }}
        >
          <Typography variant="body1" color="text.secondary">
            Browse lessons shared by the community. Open one to preview it.
          </Typography>
          {lessonHubEnabled && (
            <IconButton onClick={load} disabled={loading} aria-label="refresh">
              <RefreshIcon />
            </IconButton>
          )}
        </Stack>

        {!lessonHubEnabled && (
          <Alert severity="info">
            The lesson hub is not configured (VITE_API_URL is missing).
          </Alert>
        )}

        {lessonHubEnabled && error && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={load}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        {lessonHubEnabled && loading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
            <CircularProgress />
          </Box>
        )}

        {lessonHubEnabled && !loading && !error && lessons.length === 0 && (
          <Paper
            variant="outlined"
            sx={{ p: 6, textAlign: "center", borderStyle: "dashed" }}
          >
            <Typography variant="h6" gutterBottom>
              No lessons yet
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Be the first to publish — build a lesson in the editor and press{" "}
              <strong>Publish to hub</strong>.
            </Typography>
          </Paper>
        )}

        {lessonHubEnabled && !loading && !error && lessons.length > 0 && (
          <Grid container spacing={2}>
            {lessons.map((lesson) => (
              <Grid key={lesson.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <Card variant="outlined" sx={{ height: "100%" }}>
                  <CardActionArea
                    onClick={() => openLesson(lesson)}
                    sx={{ height: "100%", alignItems: "stretch" }}
                  >
                    <CardContent>
                      <Typography variant="h6" gutterBottom noWrap>
                        {lesson.title || "Untitled Lesson"}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {lesson.author || "Anonymous"}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: "block", mt: 1 }}
                      >
                        {typeof lesson.sectionCount === "number"
                          ? `${lesson.sectionCount} section${lesson.sectionCount === 1 ? "" : "s"}`
                          : ""}
                        {lesson.createdAt
                          ? ` · ${formatDate(lesson.createdAt)}`
                          : ""}
                      </Typography>
                    </CardContent>
                  </CardActionArea>
                </Card>
              </Grid>
            ))}
          </Grid>
        )}
      </Container>

      <Dialog
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        fullWidth
        maxWidth="md"
        scroll="paper"
      >
        <DialogTitle>{viewing?.title || "Lesson"}</DialogTitle>
        <DialogContent dividers>
          {viewLoading && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
              <CircularProgress />
            </Box>
          )}
          {!viewLoading && viewError && (
            <Alert severity="error">{viewError}</Alert>
          )}
          {!viewLoading && !viewError && (
            <Box
              className="s2c-preview-root"
              sx={{ bgcolor: "#fff", color: "#1a1a1a", p: 2 }}
              dangerouslySetInnerHTML={{
                __html: `<style>${PREVIEW_STYLES}</style>${viewHtml}`,
              }}
            />
          )}
          {/* Comments live below the preview; they load independently of the
              lesson doc, so show them whenever a lesson is open and its doc
              didn't fail to load. */}
          {!viewLoading && !viewError && viewing && (
            <CommentsSection lessonId={viewing.id} />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewing(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
