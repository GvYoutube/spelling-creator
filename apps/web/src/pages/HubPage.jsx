// Lesson hub — a public, read-only gallery of lessons other users have
// published. Summaries come from the Worker (GET /lessons); clicking a card
// navigates to that lesson's own page (/hub/:id), where the full document is
// fetched and rendered. Each lesson therefore has a shareable URL.
//
// The search box (when Algolia is configured) queries the search index the
// Worker keeps in sync. An empty box shows the full newest-first listing; typing
// swaps the grid for matching hits, rendered with the very same cards.

import { useEffect, useState } from "react";
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
import InputAdornment from "@mui/material/InputAdornment";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import IconButton from "@mui/material/IconButton";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import ClearIcon from "@mui/icons-material/Clear";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import NavActions from "../components/NavActions.jsx";
import {
  fetchPublishedLessons,
  deleteLesson,
  lessonHubEnabled,
  EDIT_REQUEST_KEY,
} from "../lib/lessons.js";
import { algoliaEnabled, searchLessons } from "../lib/algolia.js";
import { useAuth } from "../lib/auth.jsx";

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
  const { user, accessToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Search box (only shown when Algolia is configured). `query` is the raw input;
  // a non-empty trimmed value switches the grid from the full listing to the
  // Algolia hits in `searchResults`. `searching`/`searchError` track that
  // separate request so they don't clobber the listing's own loading/error.
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  const trimmedQuery = query.trim();
  const isSearching = algoliaEnabled && trimmedQuery.length > 0;

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

  useEffect(() => {
    if (lessonHubEnabled) load();
    else setLoading(false);
  }, []);

  // Debounced live search. Each keystroke (after a 300ms pause) queries Algolia;
  // an empty box clears the results so the full listing shows again. The `active`
  // flag drops the response from a superseded query so a slow earlier request
  // can't overwrite a newer one's results.
  useEffect(() => {
    if (!algoliaEnabled || !trimmedQuery) {
      setSearchResults([]);
      setSearchError("");
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    setSearchError("");
    const t = setTimeout(async () => {
      try {
        const results = await searchLessons(trimmedQuery);
        if (!active) return;
        setSearchResults(results);
      } catch (err) {
        if (!active) return;
        setSearchError(err.message || "Search failed.");
        setSearchResults([]);
      } finally {
        if (active) setSearching(false);
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [trimmedQuery]);

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

  // When the user is searching, the grid below shows the Algolia hits with their
  // own loading/error; otherwise it shows the full listing. The card markup is
  // identical either way, so we just pick which source/flags to render.
  const displayed = isSearching ? searchResults : lessons;
  const displayLoading = isSearching ? searching : loading;
  const displayError = isSearching ? searchError : error;

  const confirmDelete = async () => {
    if (!deleting || !deleteConfirmed) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteLesson(deleting.id, accessToken);
      // Drop it from the listing (and any visible search hits) locally so it
      // disappears immediately.
      setLessons((prev) => prev.filter((l) => l.id !== deleting.id));
      setSearchResults((prev) => prev.filter((l) => l.id !== deleting.id));
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
            <IconButton onClick={load} disabled={loading} aria-label="refresh">
              <RefreshIcon />
            </IconButton>
          )}
        </Stack>

        {lessonHubEnabled && algoliaEnabled && (
          <TextField
            fullWidth
            size="small"
            placeholder="Search lessons by title or author…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ mb: 2 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="action" />
                </InputAdornment>
              ),
              endAdornment: query ? (
                <InputAdornment position="end">
                  {searching ? (
                    <CircularProgress size={18} />
                  ) : (
                    <IconButton
                      size="small"
                      aria-label="clear search"
                      onClick={() => setQuery("")}
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  )}
                </InputAdornment>
              ) : null,
            }}
          />
        )}

        {!lessonHubEnabled && (
          <Alert severity="info">
            The lesson hub is not configured (VITE_API_URL is missing).
          </Alert>
        )}

        {lessonHubEnabled && displayError && (
          <Alert
            severity="error"
            action={
              // The listing can be retried with the refresh button; a failed
              // search just re-runs as the user keeps typing, so no Retry there.
              isSearching ? undefined : (
                <Button color="inherit" size="small" onClick={load}>
                  Retry
                </Button>
              )
            }
          >
            {displayError}
          </Alert>
        )}

        {lessonHubEnabled && displayLoading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
            <CircularProgress />
          </Box>
        )}

        {lessonHubEnabled &&
          !displayLoading &&
          !displayError &&
          displayed.length === 0 &&
          (isSearching ? (
            <Paper
              variant="outlined"
              sx={{ p: 6, textAlign: "center", borderStyle: "dashed" }}
            >
              <Typography variant="h6" gutterBottom>
                No lessons match “{trimmedQuery}”
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Try a different title or author.
              </Typography>
            </Paper>
          ) : (
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
          ))}

        {lessonHubEnabled &&
          !displayLoading &&
          !displayError &&
          displayed.length > 0 && (
            <Grid container spacing={2}>
              {displayed.map((lesson) => (
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
        open={Boolean(deleting)}
        onClose={closeDelete}
        fullWidth
        maxWidth="xs"
      >
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
