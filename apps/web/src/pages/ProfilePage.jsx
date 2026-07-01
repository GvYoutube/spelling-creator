// A user's public profile (/users/:id). Shows their chosen display name, bio,
// follower/following counts, and the lessons they've published; the owner can edit
// their bio in place, and any other signed-in user can follow/unfollow them (which
// notifies the followed user and surfaces their activity in the follower's home
// feed). Profiles are keyed by the Supabase user id (the same `authorId` on every
// lesson), so a link survives a display-name change. The "RSS" button points at
// the user's Atom activity feed (lessons + comments) served by the Worker.

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
import Link from "@mui/material/Link";
import Alert from "@mui/material/Alert";
import Skeleton from "@mui/material/Skeleton";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemText from "@mui/material/ListItemText";
import CircularProgress from "@mui/material/CircularProgress";
import EditIcon from "@mui/icons-material/Edit";
import RssFeedIcon from "@mui/icons-material/RssFeed";
import HistoryIcon from "@mui/icons-material/History";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import HowToRegIcon from "@mui/icons-material/HowToReg";
import NavActions from "../components/NavActions.jsx";
import BioDialog from "../components/BioDialog.jsx";
import FollowListDialog from "../components/FollowListDialog.jsx";
import { LessonGridSkeleton } from "../components/Skeletons.jsx";
import {
  fetchUserProfile,
  fetchUserActivity,
  setFollowing,
  userFeedUrl,
} from "../lib/users.js";
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
  const { user: me, accessToken, enabled } = useAuth();
  const isOwner = Boolean(me && me.id === id);

  const [profile, setProfile] = useState(null);
  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bioOpen, setBioOpen] = useState(false);

  // Follow state. `followBusy` disables the button (and shows a spinner) while a
  // follow/unfollow request is in flight; `followError` surfaces a failure. The
  // follow flag and counts live on `profile` so a successful toggle just patches
  // it (the server returns the fresh follower count).
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState("");
  // Which connections list the follower/following-count dialog is showing, or null
  // when it's closed.
  const [followListTab, setFollowListTab] = useState(null);

  // Activity menu: lazily parsed from the user's Atom feed on first open.
  const [activityAnchor, setActivityAnchor] = useState(null);
  const [activity, setActivity] = useState([]);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");

  const openActivity = (e) => {
    setActivityAnchor(e.currentTarget);
    if (activityLoaded) return;
    setActivityLoaded(true);
    setActivityLoading(true);
    setActivityError("");
    fetchUserActivity(id)
      .then(setActivity)
      .catch((err) =>
        setActivityError(err.message || "Could not load activity."),
      )
      .finally(() => setActivityLoading(false));
  };

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError("");
    // Pass the token so the server can tell us whether *we* follow this profile.
    fetchUserProfile(id, accessToken)
      .then(({ user, lessons }) => {
        setProfile(user);
        setLessons(lessons);
      })
      .catch((err) => setError(err.message || "Could not load this profile."))
      .finally(() => setLoading(false));
  }, [id, accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  // Follow or unfollow this profile, then patch the local follow flag + count
  // from the server's response so the button and header update immediately.
  const toggleFollow = async () => {
    if (!profile || followBusy) return;
    const next = !profile.isFollowing;
    setFollowBusy(true);
    setFollowError("");
    try {
      const { following, followerCount } = await setFollowing(
        id,
        next,
        accessToken,
      );
      setProfile((p) =>
        p ? { ...p, isFollowing: following, followerCount } : p,
      );
    } catch (err) {
      setFollowError(err.message || "Could not update follow.");
    } finally {
      setFollowBusy(false);
    }
  };

  // The Follow control shows only to a signed-in user viewing someone else.
  const canFollow = Boolean(enabled && me && !isOwner);

  const displayName = profile?.displayName || "Anonymous";
  const bio = profile?.bio || "";
  const followerCount = profile?.followerCount ?? 0;
  const followingCount = profile?.followingCount ?? 0;

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
          <>
            {/* Header placeholder: avatar + name/bio lines, then the lessons grid. */}
            <Stack direction="row" spacing={2} sx={{ mb: 4 }}>
              <Skeleton variant="circular" width={56} height={56} />
              <Box sx={{ flexGrow: 1 }}>
                <Skeleton
                  variant="text"
                  sx={{ fontSize: "1.5rem" }}
                  width="40%"
                />
                <Skeleton variant="text" width="60%" />
              </Box>
            </Stack>
            <LessonGridSkeleton count={3} />
          </>
        ) : error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : (
          <>
            {/* Profile header: avatar, display name, follower/following counts,
                the Follow button, and the Activity/RSS buttons. */}
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
                <Stack
                  direction="row"
                  spacing={1.5}
                  alignItems="baseline"
                  sx={{ flexWrap: "wrap" }}
                >
                  <Typography variant="body2" color="text.secondary">
                    {lessons.length} published lesson
                    {lessons.length === 1 ? "" : "s"}
                  </Typography>
                  {/* Counts open the connections dialog on the matching tab. */}
                  <Link
                    component="button"
                    type="button"
                    variant="body2"
                    color="text.secondary"
                    underline="hover"
                    onClick={() => setFollowListTab("followers")}
                  >
                    {followerCount} follower{followerCount === 1 ? "" : "s"}
                  </Link>
                  <Link
                    component="button"
                    type="button"
                    variant="body2"
                    color="text.secondary"
                    underline="hover"
                    onClick={() => setFollowListTab("following")}
                  >
                    {followingCount} following
                  </Link>
                </Stack>
              </Box>
              <Stack direction="row" spacing={1} alignItems="center">
                {canFollow && (
                  <Button
                    variant={profile?.isFollowing ? "outlined" : "contained"}
                    size="small"
                    onClick={toggleFollow}
                    disabled={followBusy}
                    startIcon={
                      followBusy ? (
                        <CircularProgress size={16} color="inherit" />
                      ) : profile?.isFollowing ? (
                        <HowToRegIcon />
                      ) : (
                        <PersonAddIcon />
                      )
                    }
                  >
                    {profile?.isFollowing ? "Following" : "Follow"}
                  </Button>
                )}
                {feedUrl && (
                  <>
                    <Tooltip title="Recent activity (lessons & comments)">
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<HistoryIcon />}
                        onClick={openActivity}
                        aria-haspopup="true"
                        aria-expanded={Boolean(activityAnchor)}
                      >
                        Activity
                      </Button>
                    </Tooltip>
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
                  </>
                )}
              </Stack>
            </Stack>
            {followError && (
              <Alert
                severity="error"
                sx={{ mb: 1 }}
                onClose={() => setFollowError("")}
              >
                {followError}
              </Alert>
            )}

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

      {/* Scrollable activity menu — parsed from the same Atom feed as the RSS button. */}
      <Menu
        anchorEl={activityAnchor}
        open={Boolean(activityAnchor)}
        onClose={() => setActivityAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: { sx: { width: 340, maxWidth: "90vw", maxHeight: 360 } },
        }}
      >
        {activityLoading ? (
          <Box sx={{ px: 2, py: 1 }}>
            {Array.from({ length: 4 }, (_, i) => (
              <Box key={i} sx={{ py: 0.75 }}>
                <Skeleton variant="text" width="70%" />
                <Skeleton variant="text" width="40%" />
              </Box>
            ))}
          </Box>
        ) : activityError ? (
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography variant="body2" color="error">
              {activityError}
            </Typography>
          </Box>
        ) : activity.length === 0 ? (
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              No recent activity.
            </Typography>
          </Box>
        ) : (
          activity.map((item) => (
            <MenuItem
              key={item.id}
              component="a"
              href={item.link}
              onClick={() => setActivityAnchor(null)}
              sx={{ whiteSpace: "normal", alignItems: "flex-start" }}
            >
              <ListItemText
                primary={item.title}
                secondary={
                  [item.summary, formatDate(item.updated)]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
                primaryTypographyProps={{ noWrap: true }}
                secondaryTypographyProps={{
                  sx: {
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  },
                }}
              />
            </MenuItem>
          ))
        )}
      </Menu>

      {isOwner && (
        <BioDialog
          open={bioOpen}
          initial={bio}
          onClose={() => setBioOpen(false)}
          onSaved={(saved) => setProfile((p) => (p ? { ...p, bio: saved } : p))}
        />
      )}

      <FollowListDialog
        open={Boolean(followListTab)}
        userId={id}
        displayName={displayName}
        initialTab={followListTab || "followers"}
        onClose={() => setFollowListTab(null)}
      />
    </Box>
  );
}
