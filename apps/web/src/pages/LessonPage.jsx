// A single lesson's own page, reachable at /hub/:id. This replaces the old hub
// preview dialog: opening a lesson now navigates here instead of popping a
// modal, so each lesson has a shareable URL. It fetches the full lesson by id,
// renders its document with the same docx→HTML preview pipeline the editor and
// export use, and shows the comments below. Authors get Edit/Delete here too.

import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
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
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import Chip from "@mui/material/Chip";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import DescriptionIcon from "@mui/icons-material/Description";
import ForkRightIcon from "@mui/icons-material/ForkRight";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ShieldIcon from "@mui/icons-material/Shield";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import VisibilityIcon from "@mui/icons-material/Visibility";
import BlockIcon from "@mui/icons-material/Block";
import WifiOffIcon from "@mui/icons-material/WifiOff";
import NavActions from "../components/NavActions.jsx";
import CommentsSection from "../components/CommentsSection.jsx";
import { LessonContentSkeleton } from "../components/Skeletons.jsx";
import LessonView, { lessonPlainText } from "../components/LessonView.jsx";
import {
  fetchLesson,
  deleteLesson,
  lessonHubEnabled,
  EDIT_REQUEST_KEY,
  FORK_REQUEST_KEY,
} from "../lib/lessons.js";
import {
  setShadowban,
  banName,
  banIp,
  requestLessonDeletion,
  deleteLessonAsAdmin,
} from "../lib/moderation.js";
import { useAuth } from "../lib/auth.jsx";
import {
  useDocumentMeta,
  useJsonLd,
  buildLessonCourseSchema,
  htmlToDescription,
} from "../lib/seo.js";
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
  const { user, accessToken, isModerator, isAdmin } = useAuth();
  const navigate = useNavigate();
  const theme = useTheme();
  // Below "md" the toolbar's action buttons collapse into an overflow menu.
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const [mobileMenuAnchor, setMobileMenuAnchor] = useState(null);
  const closeMobileMenu = () => setMobileMenuAnchor(null);

  const [lesson, setLesson] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Which export is in flight ('docx' | 'pdf' | null), plus a feedback toast.
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState("");

  // Delete-confirmation dialog. The user must retype the lesson's title to
  // confirm, guarding against an accidental, irreversible delete. `deleteMode`
  // is "author" for the author's own delete or "admin" for an admin full-delete
  // of someone else's lesson — same dialog, different endpoint on confirm.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState("author");
  const [deleteText, setDeleteText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Moderation menu + its dialogs/feedback.
  const [modMenuAnchor, setModMenuAnchor] = useState(null);
  const closeModMenu = () => setModMenuAnchor(null);
  const [shadowBusy, setShadowBusy] = useState(false);
  // Deletion-request dialog (a moderator asking an admin to delete this lesson).
  const [reqOpen, setReqOpen] = useState(false);
  const [reqReason, setReqReason] = useState("");
  const [reqBusy, setReqBusy] = useState(false);
  const [reqError, setReqError] = useState("");
  // IP-ban confirm dialog (admin).
  const [ipBanOpen, setIpBanOpen] = useState(false);
  const [ipBanBusy, setIpBanBusy] = useState(false);
  const [ipBanError, setIpBanError] = useState("");

  useEffect(() => {
    if (!lessonHubEnabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setLesson(null);
    (async () => {
      try {
        const full = await fetchLesson(id);
        if (cancelled) return;
        // Render happens directly from the doc via <LessonView>; images
        // lazy-load in the browser, so there's no up-front render step to wait
        // on here — the page shows as soon as the lesson JSON arrives.
        setLesson(full);
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
    navigate("/editor");
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
    navigate("/editor");
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
      // An author deletes their own lesson; an admin can fully delete anyone's.
      if (deleteMode === "admin") {
        await deleteLessonAsAdmin(id, accessToken);
      } else {
        await deleteLesson(id, accessToken);
      }
      // Hand the hub a one-shot toast so the user gets feedback after we leave.
      navigate("/hub", { state: { deletedTitle: deleteTarget } });
    } catch (err) {
      setDeleteError(err.message || "Could not delete this lesson.");
      setDeleteBusy(false);
    }
  };

  const isAuthor =
    Boolean(user) && lesson?.authorId && lesson.authorId === user.id;

  // Open the type-the-title delete dialog in author or admin mode.
  const openDelete = (mode) => {
    setDeleteMode(mode);
    setDeleteText("");
    setDeleteError("");
    setDeleteOpen(true);
  };

  // Moderator: hide/show this lesson on the public hub. Updates local state so
  // the badge and menu label flip immediately.
  const toggleShadowban = async () => {
    closeModMenu();
    if (!lesson) return;
    setShadowBusy(true);
    try {
      const next = !lesson.shadowbanned;
      await setShadowban(id, next, accessToken);
      setLesson((prev) => (prev ? { ...prev, shadowbanned: next } : prev));
      setToast(next ? "Lesson shadowbanned." : "Lesson restored.");
    } catch (err) {
      setToast(err.message || "Could not update the lesson.");
    } finally {
      setShadowBusy(false);
    }
  };

  // Moderator: ban the lesson author by display name.
  const banAuthorName = async () => {
    closeModMenu();
    const name = lesson?.author || "";
    if (!name) {
      setToast("This lesson has no author name to ban.");
      return;
    }
    try {
      await banName(name, accessToken);
      setToast(`Banned “${name}” from posting.`);
    } catch (err) {
      setToast(err.message || "Could not ban the author.");
    }
  };

  // Moderator: file a request for an admin to fully delete this lesson.
  const submitDeleteRequest = async () => {
    setReqBusy(true);
    setReqError("");
    try {
      await requestLessonDeletion(id, reqReason.trim(), accessToken);
      setReqOpen(false);
      setReqReason("");
      setToast("Deletion request sent to admins.");
    } catch (err) {
      setReqError(err.message || "Could not send the request.");
    } finally {
      setReqBusy(false);
    }
  };

  // Admin: ban the address this lesson was published from.
  const confirmIpBan = async () => {
    setIpBanBusy(true);
    setIpBanError("");
    try {
      await banIp(lesson.authorIp, "", accessToken);
      setIpBanOpen(false);
      setToast(`Banned IP ${lesson.authorIp}.`);
    } catch (err) {
      setIpBanError(err.message || "Could not ban the IP.");
    } finally {
      setIpBanBusy(false);
    }
  };

  // Description shared by the social/SEO meta tags and the Course JSON-LD below,
  // drawn from the lesson's own text with a sensible fallback.
  const description =
    (lesson && htmlToDescription(lessonPlainText(lesson.doc))) ||
    (lesson
      ? `A spelling lesson${lesson.author ? ` by ${lesson.author}` : ""}.`
      : undefined);

  // Per-page title + social/SEO tags. Crawlers receive these in the Worker's
  // prerendered snapshot.
  useDocumentMeta({
    type: "article",
    title:
      lesson?.title ||
      (loading ? "Lesson" : error ? "Lesson not found" : "Lesson"),
    description,
  });

  // schema.org Course structured data so Google can show this lesson as a rich
  // result. Captured by the prerendered snapshot the same way the meta tags are.
  // Only emit it once the lesson has loaded successfully (no markup for the
  // loading/error states).
  useJsonLd(
    lesson && !error
      ? buildLessonCourseSchema({
          lesson,
          description,
          url: `${window.location.origin}/hub/${id}`,
          origin: window.location.origin,
        })
      : null,
  );

  return (
    <Box sx={{ minHeight: "100vh", pb: 8 }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          {isMobile ? (
            <Tooltip title="Lesson hub">
              <IconButton
                color="inherit"
                component={RouterLink}
                to="/hub"
                aria-label="lesson hub"
                sx={{ mr: 0.5 }}
              >
                <ArrowBackIcon />
              </IconButton>
            </Tooltip>
          ) : (
            <Button
              color="inherit"
              component={RouterLink}
              to="/hub"
              startIcon={<ArrowBackIcon />}
              sx={{ mr: 1 }}
            >
              Lesson hub
            </Button>
          )}
          <Typography
            variant="h6"
            noWrap
            sx={{ flexGrow: 1, minWidth: 0, mr: 1 }}
            title={lesson?.title || ""}
          >
            {lesson?.title || "Lesson"}
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            {lesson && isMobile && (
              <>
                <Tooltip title="Lesson actions">
                  <IconButton
                    color="inherit"
                    onClick={(e) => setMobileMenuAnchor(e.currentTarget)}
                    aria-label="lesson actions"
                  >
                    <MoreVertIcon />
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
                      handleExport("pdf");
                    }}
                    disabled={Boolean(busy)}
                  >
                    <ListItemIcon>
                      <PictureAsPdfIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Print PDF</ListItemText>
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      closeMobileMenu();
                      handleExport("docx");
                    }}
                    disabled={Boolean(busy)}
                  >
                    <ListItemIcon>
                      <DescriptionIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Download Word</ListItemText>
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      closeMobileMenu();
                      forkLesson();
                    }}
                    disabled={Boolean(busy)}
                  >
                    <ListItemIcon>
                      <ForkRightIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Fork</ListItemText>
                  </MenuItem>
                  {isAuthor && <Divider />}
                  {isAuthor && (
                    <MenuItem
                      onClick={() => {
                        closeMobileMenu();
                        editLesson();
                      }}
                    >
                      <ListItemIcon>
                        <EditIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText>Edit</ListItemText>
                    </MenuItem>
                  )}
                  {isAuthor && (
                    <MenuItem
                      onClick={() => {
                        closeMobileMenu();
                        openDelete("author");
                      }}
                    >
                      <ListItemIcon>
                        <DeleteOutlineIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText>Delete</ListItemText>
                    </MenuItem>
                  )}
                </Menu>
              </>
            )}
            {lesson && !isMobile && (
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
            {!isMobile && isAuthor && (
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
                  onClick={() => openDelete("author")}
                >
                  Delete
                </Button>
              </>
            )}
            {/* Moderator/admin tools — one menu, shown to mods and admins. */}
            {isModerator && lesson && (
              <>
                <Tooltip title="Moderation">
                  <IconButton
                    color="inherit"
                    onClick={(e) => setModMenuAnchor(e.currentTarget)}
                    aria-label="moderation actions"
                  >
                    <ShieldIcon />
                  </IconButton>
                </Tooltip>
                <Menu
                  anchorEl={modMenuAnchor}
                  open={Boolean(modMenuAnchor)}
                  onClose={closeModMenu}
                  anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                  transformOrigin={{ vertical: "top", horizontal: "right" }}
                >
                  <MenuItem onClick={toggleShadowban} disabled={shadowBusy}>
                    <ListItemIcon>
                      {lesson.shadowbanned ? (
                        <VisibilityIcon fontSize="small" />
                      ) : (
                        <VisibilityOffIcon fontSize="small" />
                      )}
                    </ListItemIcon>
                    <ListItemText>
                      {lesson.shadowbanned
                        ? "Un-shadowban lesson"
                        : "Shadowban lesson"}
                    </ListItemText>
                  </MenuItem>
                  <MenuItem onClick={banAuthorName}>
                    <ListItemIcon>
                      <BlockIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>Ban author by name</ListItemText>
                  </MenuItem>
                  {/* Mods request deletion; admins delete outright. */}
                  {!isAdmin && (
                    <MenuItem
                      onClick={() => {
                        closeModMenu();
                        setReqReason("");
                        setReqError("");
                        setReqOpen(true);
                      }}
                    >
                      <ListItemIcon>
                        <DeleteOutlineIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText>Request deletion…</ListItemText>
                    </MenuItem>
                  )}
                  {isAdmin && (
                    <MenuItem
                      onClick={() => {
                        closeModMenu();
                        openDelete("admin");
                      }}
                    >
                      <ListItemIcon>
                        <DeleteOutlineIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText>Delete lesson fully…</ListItemText>
                    </MenuItem>
                  )}
                  {isAdmin && (
                    <MenuItem
                      onClick={() => {
                        closeModMenu();
                        setIpBanError("");
                        setIpBanOpen(true);
                      }}
                      disabled={!lesson.authorIp}
                    >
                      <ListItemIcon>
                        <WifiOffIcon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText>
                        {lesson.authorIp
                          ? "Ban author by IP"
                          : "Ban by IP (no IP on record)"}
                      </ListItemText>
                    </MenuItem>
                  )}
                </Menu>
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

        {lessonHubEnabled && loading && <LessonContentSkeleton />}

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
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="h4">
                  {lesson.title || "Untitled Lesson"}
                </Typography>
                {/* Only the author and mods/admins can load a shadowbanned
                    lesson, so this badge is never seen by the public. */}
                {lesson.shadowbanned && (
                  <Chip
                    size="small"
                    color="warning"
                    icon={<VisibilityOffIcon />}
                    label="Shadowbanned"
                  />
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {lesson.authorId ? (
                  <Box
                    component={RouterLink}
                    to={`/users/${lesson.authorId}`}
                    sx={{
                      color: "inherit",
                      textDecoration: "none",
                      "&:hover": { textDecoration: "underline" },
                    }}
                  >
                    {lesson.author || "Anonymous"}
                  </Box>
                ) : (
                  lesson.author || "Anonymous"
                )}
                {typeof lesson.sectionCount === "number"
                  ? ` · ${lesson.sectionCount} section${lesson.sectionCount === 1 ? "" : "s"}`
                  : ""}
                {lesson.createdAt ? ` · ${formatDate(lesson.createdAt)}` : ""}
              </Typography>
            </Stack>

            <Paper variant="outlined" sx={{ overflow: "hidden" }}>
              <LessonView doc={lesson.doc} />
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

      {/* Moderator → admin: request that this lesson be fully deleted. */}
      <Dialog
        open={reqOpen}
        onClose={() => !reqBusy && setReqOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Request deletion</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Ask an admin to permanently delete <strong>{deleteTarget}</strong>.
            Add a reason to help them decide.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Reason (optional)"
            multiline
            minRows={2}
            value={reqReason}
            onChange={(e) => setReqReason(e.target.value)}
            disabled={reqBusy}
            inputProps={{ maxLength: 1000 }}
          />
          {reqError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {reqError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReqOpen(false)} disabled={reqBusy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={submitDeleteRequest}
            disabled={reqBusy}
            startIcon={
              reqBusy ? <CircularProgress size={16} color="inherit" /> : null
            }
          >
            Send request
          </Button>
        </DialogActions>
      </Dialog>

      {/* Admin: ban the IP this lesson was published from. */}
      <Dialog
        open={ipBanOpen}
        onClose={() => !ipBanBusy && setIpBanOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Ban this IP address?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This blocks all posting from{" "}
            <strong>{lesson?.authorIp || "this address"}</strong> (the address{" "}
            <strong>{lesson?.author || "the author"}</strong> published this
            lesson from). Existing content stays in place.
          </DialogContentText>
          {ipBanError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {ipBanError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIpBanOpen(false)} disabled={ipBanBusy}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={confirmIpBan}
            disabled={ipBanBusy || !lesson?.authorIp}
            startIcon={
              ipBanBusy ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <WifiOffIcon />
              )
            }
          >
            Ban IP
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
