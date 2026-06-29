// Lesson hub — a public, read-only gallery of lessons other users have
// published. Summaries come from the Worker (GET /lessons); clicking a card
// navigates to that lesson's own page (/hub/:id), where the full document is
// fetched and rendered. Each lesson therefore has a shareable URL.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate, useLocation } from "react-router-dom";
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
import DialogContentText from "@mui/material/DialogContentText";
import TextField from "@mui/material/TextField";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Chip from "@mui/material/Chip";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import RssFeedIcon from "@mui/icons-material/RssFeed";
import SearchIcon from "@mui/icons-material/Search";
import ClearIcon from "@mui/icons-material/Clear";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import NavActions from "../components/NavActions.jsx";
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

export default function HubPage() {
  useDocumentMeta({
    title: "Lesson hub",
    description:
      "Browse and copy community-made spelling lessons, then print or export them.",
  });
  const { user, accessToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

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
  const [toast, setToast] = useState("");

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
      setToast(`Deleted “${deletedTitle}”.`);
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
    navigate("/");
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
      setToast(`Deleted “${deleteTarget}”.`);
      setDeleting(null);
    } catch (err) {
      setDeleteError(err.message || "Could not delete this lesson.");
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: "100vh", pb: 8 }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          {isMobile ? (
            <Tooltip title="Editor">
              <IconButton
                color="inherit"
                component={RouterLink}
                to="/"
                aria-label="editor"
                sx={{ mr: 0.5 }}
              >
                <EditIcon />
              </IconButton>
            </Tooltip>
          ) : (
            <Button
              color="inherit"
              component={RouterLink}
              to="/"
              startIcon={<EditIcon />}
              sx={{ mr: 1 }}
            >
              Editor
            </Button>
          )}
          <Typography
            variant="h6"
            noWrap
            sx={{ flexGrow: 1, minWidth: 0, mr: 1 }}
          >
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
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Tooltip title="Subscribe to the latest lessons (RSS)">
                <IconButton
                  component="a"
                  href={lessonsFeedUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="latest lessons RSS feed"
                >
                  <RssFeedIcon />
                </IconButton>
              </Tooltip>
              <IconButton
                onClick={() => {
                  load();
                  loadDrafts();
                }}
                disabled={loading}
                aria-label="refresh"
              >
                <RefreshIcon />
              </IconButton>
            </Stack>
          )}
        </Stack>

        {lessonHubEnabled && drafts.length > 0 && (
          <Box sx={{ mb: 4 }}>
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              flexWrap="wrap"
              useFlexGap
              sx={{ mb: 1.5 }}
            >
              <CloudQueueIcon fontSize="small" color="action" />
              <Typography variant="h6">Your drafts</Typography>
              <Typography variant="body2" color="text.secondary">
                Backed up to the cloud, visible only to you. Open one to edit
                and publish it.
              </Typography>
            </Stack>
            <Grid container spacing={2}>
              {drafts.map((lesson) => (
                <Grid key={lesson.id} size={{ xs: 12, sm: 6, md: 4 }}>
                  <Card
                    variant="outlined"
                    sx={{ height: "100%", position: "relative" }}
                  >
                    <Stack
                      direction="row"
                      spacing={0.5}
                      sx={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        zIndex: 1,
                      }}
                    >
                      <Tooltip title="Edit this draft">
                        <IconButton
                          size="small"
                          aria-label="edit draft"
                          onClick={(e) => editLesson(e, lesson)}
                          sx={{
                            bgcolor: "background.paper",
                            "&:hover": { bgcolor: "action.hover" },
                          }}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete this draft">
                        <IconButton
                          size="small"
                          aria-label="delete draft"
                          onClick={(e) => askDelete(e, lesson)}
                          sx={{
                            bgcolor: "background.paper",
                            "&:hover": {
                              bgcolor: "error.light",
                              color: "error.contrastText",
                            },
                          }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    <CardActionArea
                      component={RouterLink}
                      to={`/hub/${lesson.id}`}
                      sx={{ height: "100%", alignItems: "stretch" }}
                    >
                      <CardContent>
                        <Chip
                          size="small"
                          variant="outlined"
                          icon={<CloudQueueIcon />}
                          label="Draft"
                          sx={{ mb: 1 }}
                        />
                        <Typography
                          variant="h6"
                          gutterBottom
                          noWrap
                          sx={{ pr: 4 }}
                        >
                          {lesson.title || "Untitled Lesson"}
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
          </Box>
        )}

        {lessonHubEnabled && !loading && !error && lessons.length > 0 && (
          <TextField
            fullWidth
            size="small"
            placeholder="Search lessons by title or author…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ mb: 2 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      aria-label="clear search"
                      onClick={() => setQuery("")}
                      edge="end"
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : null,
              },
            }}
          />
        )}

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

        {lessonHubEnabled && loading && <LessonGridSkeleton />}

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

        {lessonHubEnabled &&
          !loading &&
          !error &&
          lessons.length > 0 &&
          searching &&
          visibleLessons.length === 0 && (
            <Paper
              variant="outlined"
              sx={{ p: 6, textAlign: "center", borderStyle: "dashed" }}
            >
              <Typography variant="h6" gutterBottom>
                No matches
              </Typography>
              <Typography variant="body2" color="text.secondary">
                No lessons match “{debouncedQuery}”. Try a different search.
              </Typography>
            </Paper>
          )}

        {lessonHubEnabled &&
          !loading &&
          !error &&
          visibleLessons.length > 0 && (
            <Grid container spacing={2}>
              {visibleLessons.map((lesson) => (
                <Grid key={lesson.id} size={{ xs: 12, sm: 6, md: 4 }}>
                  <Card
                    variant="outlined"
                    sx={{ height: "100%", position: "relative" }}
                  >
                    {user && lesson.authorId && lesson.authorId === user.id && (
                      <Stack
                        direction="row"
                        spacing={0.5}
                        sx={{
                          position: "absolute",
                          top: 4,
                          right: 4,
                          zIndex: 1,
                        }}
                      >
                        <Tooltip title="Edit this lesson">
                          <IconButton
                            size="small"
                            aria-label="edit lesson"
                            onClick={(e) => editLesson(e, lesson)}
                            sx={{
                              bgcolor: "background.paper",
                              "&:hover": { bgcolor: "action.hover" },
                            }}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete this lesson">
                          <IconButton
                            size="small"
                            aria-label="delete lesson"
                            onClick={(e) => askDelete(e, lesson)}
                            sx={{
                              bgcolor: "background.paper",
                              "&:hover": {
                                bgcolor: "error.light",
                                color: "error.contrastText",
                              },
                            }}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    )}
                    <CardActionArea
                      component={RouterLink}
                      to={`/hub/${lesson.id}`}
                      sx={{ height: "100%", alignItems: "stretch" }}
                    >
                      <CardContent>
                        <Typography
                          variant="h6"
                          gutterBottom
                          noWrap
                          sx={{ pr: 4 }}
                        >
                          {lesson.title || "Untitled Lesson"}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {lesson.authorId ? (
                            // The whole card is already a link, so the author can't
                            // be a nested <a>. Use a clickable span that navigates
                            // to the profile and stops the card's own navigation.
                            <Box
                              component="span"
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
                              sx={{
                                cursor: "pointer",
                                "&:hover": { textDecoration: "underline" },
                              }}
                            >
                              {lesson.author || "Anonymous"}
                            </Box>
                          ) : (
                            lesson.author || "Anonymous"
                          )}
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
        open={Boolean(deleting)}
        onClose={closeDelete}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Delete this lesson?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            This permanently deletes <strong>{deleteTarget}</strong>. This can’t
            be undone. To confirm, type the lesson’s name below.
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
