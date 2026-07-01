// The app's landing page, served at "/". It has two faces:
//
//   • Signed out — a marketing splash: a hero whose backdrop is real spelling
//     words from the hub drifting upward (see FloatingWords), followed by a calm
//     run of feature blurbs, each with an illustration beside it.
//   • Signed in — a personal dashboard: the hub's latest-lessons feed and the
//     user's own activity feed side by side (both parsed from Atom with
//     DOMParser), a feed of activity from the people they follow, plus a roomier
//     list of the user's notifications.
//
// The editor itself now lives at /editor; this page is what greets visitors.

import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Grid from "@mui/material/Grid2";
import Paper from "@mui/material/Paper";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import EditIcon from "@mui/icons-material/Edit";
import SpellcheckIcon from "@mui/icons-material/Spellcheck";
import CollectionsBookmarkIcon from "@mui/icons-material/CollectionsBookmark";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ImageSearchIcon from "@mui/icons-material/ImageSearch";
import GroupsIcon from "@mui/icons-material/Groups";
import DescriptionIcon from "@mui/icons-material/Description";
import RssFeedIcon from "@mui/icons-material/RssFeed";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";
import HistoryIcon from "@mui/icons-material/History";
import PeopleAltIcon from "@mui/icons-material/PeopleAlt";
import NavActions from "../components/NavActions.jsx";
import FloatingWords from "../components/FloatingWords.jsx";
import { FeedListSkeleton } from "../components/Skeletons.jsx";
import { useAuth } from "../lib/auth.jsx";
import { useDocumentMeta } from "../lib/seo.js";
import { fetchLatestLessons, lessonHubEnabled } from "../lib/lessons.js";
import { fetchUserActivity, fetchFollowingActivity } from "../lib/users.js";
import { fetchNotifications } from "../lib/notifications.js";

// The features shown to signed-out visitors. `image` points at a file under
// apps/web/public/home/ (see that folder's README); a missing file degrades to a
// labelled placeholder. Rows alternate the image left/right down the page.
const FEATURES = [
  {
    key: "editor",
    icon: EditIcon,
    title: "A focused lesson editor",
    body: "Build lessons from named sections, each holding text, images, spelling-word lists and question blocks. Everything autosaves as you go.",
    image: "/home/feature-editor.jpg",
  },
  {
    key: "ai",
    icon: AutoAwesomeIcon,
    title: "AI that helps you write",
    body: "Draft passage text, generate question ideas, or spin up a whole lesson concept with built-in AI suggestions — then edit anything to taste.",
    image: "/home/feature-ai.jpg",
  },
  {
    key: "images",
    icon: ImageSearchIcon,
    title: "Find the perfect picture",
    body: "Search free image libraries without leaving the editor and drop an illustration straight into any section.",
    image: "/home/feature-images.jpg",
  },
  {
    key: "hub",
    icon: CollectionsBookmarkIcon,
    title: "Share to the community hub",
    body: "Publish a lesson for everyone, browse what others have made, and copy any lesson to remix it into your own.",
    image: "/home/feature-hub.jpg",
  },
  {
    key: "collab",
    icon: GroupsIcon,
    title: "Collaborate live",
    body: "Invite a colleague to edit the same lesson in real time, with live cursors and a built-in chat.",
    image: "/home/feature-collab.jpg",
  },
  {
    key: "export",
    icon: DescriptionIcon,
    title: "Export anywhere",
    body: "Download a finished lesson as a Word document or PDF, or save it straight to Google Docs for printing and sharing.",
    image: "/home/feature-export.jpg",
  },
];

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Turn an absolute feed link (same-origin, e.g. https://site/hub/:id) into an
// app-relative path so it can route client-side without a full page load. Falls
// back to the original string if it isn't parseable.
function toPath(href) {
  if (!href) return "";
  try {
    const u = new URL(href, window.location.origin);
    return u.origin === window.location.origin ? u.pathname + u.search : href;
  } catch {
    return href;
  }
}

// A feature illustration that degrades to a labelled placeholder if the image
// file hasn't been added yet (see public/home/README.md).
function FeatureImage({ src, alt, Icon }) {
  const [broken, setBroken] = useState(false);
  if (broken || !src) {
    return (
      <Box
        sx={{
          width: "100%",
          aspectRatio: "16 / 10",
          borderRadius: 3,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 1,
          color: "primary.main",
          bgcolor: "action.hover",
          border: "1px dashed",
          borderColor: "divider",
        }}
      >
        <Icon sx={{ fontSize: 48, opacity: 0.6 }} />
        <Typography variant="caption" color="text.secondary">
          {alt}
        </Typography>
      </Box>
    );
  }
  return (
    <Box
      component="img"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      sx={{
        width: "100%",
        aspectRatio: "16 / 10",
        objectFit: "cover",
        borderRadius: 3,
        boxShadow: 3,
        display: "block",
      }}
    />
  );
}

// One alternating feature row: illustration on one side, copy on the other.
function FeatureRow({ feature, flip }) {
  const Icon = feature.icon;
  return (
    <Grid container spacing={{ xs: 3, md: 6 }} alignItems="center">
      <Grid size={{ xs: 12, md: 6 }} order={{ xs: 1, md: flip ? 2 : 1 }}>
        <FeatureImage src={feature.image} alt={feature.title} Icon={Icon} />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }} order={{ xs: 2, md: flip ? 1 : 2 }}>
        <Stack spacing={1.5}>
          <Box
            sx={{
              width: 48,
              height: 48,
              borderRadius: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: "primary.main",
              color: "primary.contrastText",
            }}
          >
            <Icon />
          </Box>
          <Typography variant="h5" component="h3">
            {feature.title}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {feature.body}
          </Typography>
        </Stack>
      </Grid>
    </Grid>
  );
}

// ── Signed-out splash ───────────────────────────────────────────────────────
function LandingView() {
  return (
    <>
      {/* Hero: floating spelling words behind a headline + calls to action. */}
      <Box
        sx={{
          position: "relative",
          overflow: "hidden",
          minHeight: { xs: "70vh", md: "78vh" },
          display: "flex",
          alignItems: "center",
          color: "common.white",
          background:
            "linear-gradient(135deg, #1b2a6b 0%, #3b5bdb 55%, #5f3dc4 100%)",
        }}
      >
        <FloatingWords />
        {/* Darkening veil so the headline stays legible over the words. */}
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 50% 40%, rgba(0,0,0,0.15), rgba(0,0,0,0.55))",
            pointerEvents: "none",
          }}
        />
        <Container
          maxWidth="md"
          sx={{ position: "relative", textAlign: "center", py: 8 }}
        >
          <Typography
            variant="h2"
            component="h1"
            sx={{
              fontWeight: 800,
              mb: 2,
              textShadow: "0 2px 18px rgba(0,0,0,0.4)",
            }}
          >
            Spelling lessons that stick
          </Typography>
          <Typography
            variant="h6"
            sx={{
              fontWeight: 400,
              mb: 4,
              opacity: 0.95,
              textShadow: "0 1px 10px rgba(0,0,0,0.4)",
            }}
          >
            Build, share and print Spelling (S2C) lessons — with a focused
            editor, AI help, images and live collaboration.
          </Typography>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            justifyContent="center"
          >
            <Button
              size="large"
              variant="contained"
              color="secondary"
              component={RouterLink}
              to="/editor"
              startIcon={<EditIcon />}
              sx={{ px: 4, py: 1.25, fontSize: "1.05rem" }}
            >
              Open the editor
            </Button>
            <Button
              size="large"
              variant="outlined"
              component={RouterLink}
              to="/hub"
              startIcon={<CollectionsBookmarkIcon />}
              sx={{
                px: 4,
                py: 1.25,
                fontSize: "1.05rem",
                color: "common.white",
                borderColor: "rgba(255,255,255,0.7)",
                "&:hover": { borderColor: "common.white" },
              }}
            >
              Browse the hub
            </Button>
          </Stack>
        </Container>
      </Box>

      {/* Calm feature run. */}
      <Container maxWidth="lg" sx={{ py: { xs: 6, md: 10 } }}>
        <Box sx={{ textAlign: "center", mb: { xs: 5, md: 8 } }}>
          <Typography variant="overline" color="primary">
            Everything you need
          </Typography>
          <Typography variant="h3" component="h2" sx={{ fontWeight: 700 }}>
            From blank page to printed lesson
          </Typography>
        </Box>
        <Stack spacing={{ xs: 7, md: 12 }}>
          {FEATURES.map((feature, i) => (
            <FeatureRow
              key={feature.key}
              feature={feature}
              flip={i % 2 === 1}
            />
          ))}
        </Stack>

        <Paper
          variant="outlined"
          sx={{
            mt: { xs: 8, md: 12 },
            p: { xs: 4, md: 6 },
            textAlign: "center",
            borderRadius: 4,
          }}
        >
          <Typography variant="h4" sx={{ fontWeight: 700, mb: 1.5 }}>
            Ready to make your first lesson?
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
            No account needed to start building — sign in only when you want to
            publish or collaborate.
          </Typography>
          <Button
            size="large"
            variant="contained"
            component={RouterLink}
            to="/editor"
            startIcon={<EditIcon />}
            sx={{ px: 4, py: 1.25 }}
          >
            Open the editor
          </Button>
        </Paper>
      </Container>
    </>
  );
}

// A compact feed list shared by the dashboard's "latest lessons" and "your
// activity" columns. Each entry routes to its lesson/profile page on click.
function FeedList({ entries, emptyText }) {
  const navigate = useNavigate();
  if (entries.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
        {emptyText}
      </Typography>
    );
  }
  return (
    <Stack divider={<Divider flexItem />} spacing={0}>
      {entries.map((e) => {
        const path = toPath(e.link);
        return (
          <Card
            key={e.id || e.link}
            elevation={0}
            sx={{ bgcolor: "transparent" }}
          >
            <CardActionArea
              onClick={() => path && navigate(path)}
              sx={{ px: 1, py: 1.25, borderRadius: 2 }}
            >
              <Typography variant="subtitle2" noWrap>
                {e.title || "Untitled"}
              </Typography>
              {e.summary && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {e.summary}
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary">
                {formatDateTime(e.updated)}
              </Typography>
            </CardActionArea>
          </Card>
        );
      })}
    </Stack>
  );
}

// ── Signed-in dashboard ─────────────────────────────────────────────────────
function DashboardView() {
  const { user, accessToken, displayName } = useAuth();
  const navigate = useNavigate();

  const [latest, setLatest] = useState([]);
  const [activity, setActivity] = useState([]);
  const [following, setFollowing] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // Each feed is independent; one failing shouldn't blank the others.
    const [latestRes, activityRes, followingRes, notifRes] =
      await Promise.allSettled([
        lessonHubEnabled ? fetchLatestLessons() : Promise.resolve([]),
        user ? fetchUserActivity(user.id) : Promise.resolve([]),
        accessToken ? fetchFollowingActivity(accessToken) : Promise.resolve([]),
        accessToken ? fetchNotifications(accessToken) : Promise.resolve([]),
      ]);
    setLatest(latestRes.status === "fulfilled" ? latestRes.value : []);
    setActivity(activityRes.status === "fulfilled" ? activityRes.value : []);
    setFollowing(followingRes.status === "fulfilled" ? followingRes.value : []);
    setNotifications(notifRes.status === "fulfilled" ? notifRes.value : []);
    setLoading(false);
  }, [user, accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Container maxWidth="lg" sx={{ py: { xs: 3, md: 5 } }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={2}
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Welcome back{displayName ? `, ${displayName}` : ""}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Pick up where you left off, or start something new.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            variant="contained"
            component={RouterLink}
            to="/editor"
            startIcon={<EditIcon />}
          >
            New lesson
          </Button>
          <Button
            variant="outlined"
            component={RouterLink}
            to="/hub"
            startIcon={<CollectionsBookmarkIcon />}
          >
            Hub
          </Button>
        </Stack>
      </Stack>

      {/* The dashboard layout renders immediately; each feed shows skeleton rows
          until its data arrives, so panels don't jump in as a spinner clears. */}
      <Stack spacing={3}>
        {/* Latest lessons + your activity, together in one section. */}
        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 3 }}>
          <Grid container spacing={{ xs: 3, md: 4 }}>
            <Grid size={{ xs: 12, md: 6 }}>
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ mb: 1.5 }}
              >
                <RssFeedIcon color="primary" fontSize="small" />
                <Typography variant="h6">Latest from the hub</Typography>
              </Stack>
              {loading ? (
                <FeedListSkeleton count={5} />
              ) : (
                <FeedList
                  entries={latest.slice(0, 8)}
                  emptyText="No published lessons yet — be the first to share one."
                />
              )}
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ mb: 1.5 }}
              >
                <HistoryIcon color="primary" fontSize="small" />
                <Typography variant="h6">Your recent activity</Typography>
              </Stack>
              {loading ? (
                <FeedListSkeleton count={5} />
              ) : (
                <FeedList
                  entries={activity.slice(0, 8)}
                  emptyText="You haven't published or commented yet. Your activity will show up here."
                />
              )}
            </Grid>
          </Grid>
        </Paper>

        {/* Activity from the people this user follows (lessons + comments). */}
        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 3 }}>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ mb: 1.5 }}
          >
            <PeopleAltIcon color="primary" fontSize="small" />
            <Typography variant="h6">From people you follow</Typography>
          </Stack>
          {loading ? (
            <FeedListSkeleton count={4} />
          ) : (
            <FeedList
              entries={following.slice(0, 10)}
              emptyText="Follow people from their profile to see their latest lessons and comments here."
            />
          )}
        </Paper>

        {/* Notifications, in a roomier view than the AppBar bell. */}
        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 3 }}>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ mb: 1.5 }}
          >
            <NotificationsNoneIcon color="primary" fontSize="small" />
            <Typography variant="h6">Notifications</Typography>
          </Stack>
          {loading ? (
            <FeedListSkeleton count={4} />
          ) : notifications.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              You&apos;re all caught up — no notifications.
            </Typography>
          ) : (
            <Stack divider={<Divider flexItem />} spacing={0}>
              {notifications.map((n) => {
                const path = n.link?.startsWith("/") ? n.link : null;
                const content = (
                  <>
                    <Stack
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      sx={{ mb: 0.25 }}
                    >
                      {!n.read && (
                        <Box
                          sx={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            bgcolor: "error.main",
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <Typography
                        variant="subtitle2"
                        sx={{ fontWeight: n.read ? 500 : 700 }}
                      >
                        {n.title}
                      </Typography>
                    </Stack>
                    {n.body && (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {n.body}
                      </Typography>
                    )}
                    <Typography variant="caption" color="text.secondary">
                      {formatDateTime(n.createdAt)}
                    </Typography>
                  </>
                );
                return n.link ? (
                  <CardActionArea
                    key={n.id}
                    onClick={() =>
                      path
                        ? navigate(path)
                        : window.open(n.link, "_blank", "noopener")
                    }
                    sx={{ px: 1, py: 1.5, borderRadius: 2 }}
                  >
                    {content}
                  </CardActionArea>
                ) : (
                  <Box key={n.id} sx={{ px: 1, py: 1.5 }}>
                    {content}
                  </Box>
                );
              })}
            </Stack>
          )}
        </Paper>
      </Stack>
    </Container>
  );
}

export default function HomePage() {
  useDocumentMeta({
    title: "Home",
    description:
      "Create, share and print Spelling (S2C) lessons with a focused editor, AI help, images and live collaboration.",
  });
  const { enabled, loading, user } = useAuth();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

  // Wait for the session to resolve before choosing a face, so a returning user
  // doesn't see the marketing splash flash before their dashboard.
  const deciding = enabled && loading;
  const signedIn = enabled && !!user;

  return (
    <Box sx={{ minHeight: "100vh", pb: 8 }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          <SpellcheckIcon sx={{ mr: 1.5, flexShrink: 0 }} />
          <Typography
            variant="h6"
            noWrap
            component={RouterLink}
            to="/"
            sx={{
              flexGrow: 1,
              minWidth: 0,
              mr: 1,
              color: "inherit",
              textDecoration: "none",
            }}
          >
            Spelling Creator
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            {isMobile ? null : (
              <Button
                color="inherit"
                variant="outlined"
                component={RouterLink}
                to="/editor"
                startIcon={<EditIcon />}
                sx={{ borderColor: "rgba(255,255,255,0.6)" }}
              >
                Editor
              </Button>
            )}
            <NavActions current="home" />
          </Stack>
        </Toolbar>
      </AppBar>

      {deciding ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 12 }}>
          <CircularProgress />
        </Box>
      ) : signedIn ? (
        <DashboardView />
      ) : (
        <>
          {!enabled && (
            <Container maxWidth="lg" sx={{ pt: 2 }}>
              <Alert severity="info">
                Accounts aren&apos;t configured, so sign-in and the dashboard
                are unavailable — the editor and hub still work.
              </Alert>
            </Container>
          )}
          <LandingView />
        </>
      )}
    </Box>
  );
}
