// A user's public profile (/users/:id). Shows their chosen display name, bio, and
// the lessons they've published; the owner can edit their bio in place. Profiles
// are keyed by the Supabase user id (the same `authorId` on every lesson), so a
// link survives a display-name change. The "RSS" button points at the user's Atom
// activity feed (lessons + comments) served by the Worker.

import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
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
import Avatar from "@mui/material/Avatar";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import EditIcon from "@mui/icons-material/Edit";
import RssFeedIcon from "@mui/icons-material/RssFeed";
import NavActions from "../components/NavActions.jsx";
import BioDialog from "../components/BioDialog.jsx";
import { fetchUserProfile, userFeedUrl } from "../lib/users.js";
import { useAuth } from "../lib/auth.jsx";
import { useDocumentMeta } from "../lib/seo.js";

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

function initial(name) {
  const s = (name || "").trim();
  return s ? s[0].toUpperCase() : "?";
}

export default function ProfilePage() {
  const { id } = useParams();
  const { user: me } = useAuth();
  const isOwner = Boolean(me && me.id === id);

  const [profile, setProfile] = useState(null);
  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bioOpen, setBioOpen] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError("");
    fetchUserProfile(id)
      .then(({ user, lessons }) => {
        setProfile(user);
        setLessons(lessons);
      })
      .catch((err) => setError(err.message || "Could not load this profile."))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const displayName = profile?.displayName || "Anonymous";
  const bio = profile?.bio || "";

  useDocumentMeta({
    title: profile ? `${displayName}` : "Profile",
    description: profile
      ? bio || `Spelling lessons published by ${displayName}.`
      : undefined,
  });

  const feedUrl = userFeedUrl(id);

  return (
    <Box sx={{ minHeight: "100vh", pb: 8 }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          <Button
            color="inherit"
            component={RouterLink}
            to="/hub"
            sx={{ mr: 1 }}
          >
            Lesson hub
          </Button>
          <Typography
            variant="h6"
            noWrap
            sx={{ flexGrow: 1, minWidth: 0, mr: 1 }}
          >
            Profile
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <NavActions current="profile" />
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ pt: 3 }}>
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : (
          <>
            {/* Profile header: avatar, display name, bio, and the RSS button. */}
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={2}
              alignItems={{ xs: "flex-start", sm: "center" }}
              sx={{ mb: 1 }}
            >
              <Avatar sx={{ width: 56, height: 56, fontSize: 24 }}>
                {initial(displayName)}
              </Avatar>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="h5" noWrap>
                  {displayName}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {lessons.length} published lesson
                  {lessons.length === 1 ? "" : "s"}
                </Typography>
              </Box>
              {feedUrl && (
                <Tooltip title="Subscribe to this user's activity (RSS)">
                  <Button
                    variant="outlined"
                    size="small"
                    component="a"
                    href={feedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    startIcon={<RssFeedIcon />}
                  >
                    RSS
                  </Button>
                </Tooltip>
              )}
            </Stack>

            {/* Bio. The owner can edit it (or add one when empty). */}
            <Box sx={{ mb: 4 }}>
              {bio ? (
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <Typography
                    variant="body1"
                    sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {bio}
                  </Typography>
                  {isOwner && (
                    <Tooltip title="Edit bio">
                      <IconButton
                        size="small"
                        aria-label="edit bio"
                        onClick={() => setBioOpen(true)}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>
              ) : isOwner ? (
                <Button
                  size="small"
                  startIcon={<EditIcon />}
                  onClick={() => setBioOpen(true)}
                >
                  Add a bio
                </Button>
              ) : null}
            </Box>

            <Typography variant="h6" gutterBottom>
              Published lessons
            </Typography>
            {lessons.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {displayName} hasn’t published any lessons yet.
              </Typography>
            ) : (
              <Grid container spacing={2}>
                {lessons.map((lesson) => (
                  <Grid key={lesson.id} size={{ xs: 12, sm: 6, md: 4 }}>
                    <Card variant="outlined" sx={{ position: "relative" }}>
                      <CardActionArea
                        component={RouterLink}
                        to={`/hub/${lesson.id}`}
                        sx={{ height: "100%", alignItems: "stretch" }}
                      >
                        <CardContent>
                          <Typography variant="h6" gutterBottom noWrap>
                            {lesson.title || "Untitled Lesson"}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: "block" }}
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
          </>
        )}
      </Container>

      {isOwner && (
        <BioDialog
          open={bioOpen}
          initial={bio}
          onClose={() => setBioOpen(false)}
          onSaved={(saved) => setProfile((p) => (p ? { ...p, bio: saved } : p))}
        />
      )}
    </Box>
  );
}
