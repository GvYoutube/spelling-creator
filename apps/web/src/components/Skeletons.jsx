// Shared loading skeletons. Skeletons stand in for content while it loads, miming
// the eventual layout — they read as "the page is nearly here" rather than the
// open-ended "still working" of a spinner, so they feel faster and nag less. We use
// them for content regions (lists, cards, a lesson's body); small in-button and
// transient overlay spinners stay as CircularProgress, where a skeleton makes no
// sense. Each export mirrors the real markup it replaces so the swap to real content
// doesn't shift the layout.

import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import Stack from "@mui/material/Stack";
import Skeleton from "@mui/material/Skeleton";

// A single lesson card placeholder, matching the hub/profile card: a title line and
// a short meta line inside an outlined card.
function LessonCardSkeleton() {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardContent>
        <Skeleton variant="text" sx={{ fontSize: "1.25rem" }} width="75%" />
        <Skeleton variant="text" width="45%" />
        <Skeleton variant="text" width="55%" sx={{ mt: 1 }} />
      </CardContent>
    </Card>
  );
}

/**
 * A responsive grid of placeholder lesson cards, matching the hub and profile
 * listings (xs:12 / sm:6 / md:4). Used while the real lessons load.
 */
export function LessonGridSkeleton({ count = 6 }) {
  return (
    <Grid container spacing={2}>
      {Array.from({ length: count }, (_, i) => (
        <Grid key={i} size={{ xs: 12, sm: 6, md: 4 }}>
          <LessonCardSkeleton />
        </Grid>
      ))}
    </Grid>
  );
}

/**
 * Placeholder for a single lesson's page: the title + author line, then the lesson
 * body as a block of text lines inside the same outlined frame the real preview uses.
 */
export function LessonContentSkeleton() {
  return (
    <>
      <Stack sx={{ mb: 2 }}>
        <Skeleton variant="text" sx={{ fontSize: "2.125rem" }} width="60%" />
        <Skeleton variant="text" width="35%" />
      </Stack>
      <Box
        sx={{
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
          p: { xs: 2, sm: 3 },
        }}
      >
        <Skeleton variant="text" sx={{ fontSize: "1.5rem" }} width="50%" />
        <Skeleton
          variant="rectangular"
          height={180}
          sx={{ my: 2, borderRadius: 1 }}
        />
        <Skeleton variant="text" />
        <Skeleton variant="text" />
        <Skeleton variant="text" width="80%" />
      </Box>
    </>
  );
}

// A single comment placeholder: a round avatar beside a name line and two body lines,
// matching the comment row in CommentsSection.
function CommentSkeleton() {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Skeleton variant="circular" width={32} height={32} />
      <Box sx={{ flexGrow: 1 }}>
        <Skeleton variant="text" width="30%" />
        <Skeleton variant="text" />
        <Skeleton variant="text" width="85%" />
      </Box>
    </Stack>
  );
}

/** A short stack of placeholder comments, used while a lesson's comments load. */
export function CommentsSkeleton({ count = 3 }) {
  return (
    <Stack spacing={2}>
      {Array.from({ length: count }, (_, i) => (
        <CommentSkeleton key={i} />
      ))}
    </Stack>
  );
}

// A single editor section placeholder, matching SectionCard: a numbered-circle +
// title header, a divider, and a content block. Mirrors the real card so the
// hydrated sections don't shift the layout when they replace it.
function SectionSkeleton() {
  return (
    <Card elevation={2}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
          <Skeleton variant="circular" width={30} height={30} />
          <Skeleton variant="text" sx={{ fontSize: "1.25rem" }} width="40%" />
        </Stack>
        <Divider sx={{ mb: 2 }} />
        <Skeleton variant="rounded" height={72} />
      </CardContent>
    </Card>
  );
}

/**
 * A stack of placeholder section cards, shown in the editor while the saved draft
 * hydrates from storage (or a hub lesson is fetched into an empty editor) — so the
 * "No sections yet" empty state never flashes before the real sections load in.
 */
export function SectionsSkeleton({ count = 2 }) {
  return (
    <Stack spacing={3}>
      {Array.from({ length: count }, (_, i) => (
        <SectionSkeleton key={i} />
      ))}
    </Stack>
  );
}

// A single feed-row placeholder, matching a row in HomePage's <FeedList>: a title
// line, a wrapped summary, and a short meta line.
function FeedRowSkeleton() {
  return (
    <Box sx={{ px: 1, py: 1.25 }}>
      <Skeleton variant="text" width="65%" />
      <Skeleton variant="text" width="90%" />
      <Skeleton variant="text" width="35%" />
    </Box>
  );
}

/**
 * A short stack of placeholder feed rows separated by dividers, mirroring the
 * dashboard's <FeedList>. Used while the home-page feeds (latest lessons, your
 * activity, people you follow, notifications) load.
 */
export function FeedListSkeleton({ count = 4 }) {
  return (
    <Stack divider={<Divider flexItem />} spacing={0}>
      {Array.from({ length: count }, (_, i) => (
        <FeedRowSkeleton key={i} />
      ))}
    </Stack>
  );
}

/**
 * Placeholder for an on-device AI summary (LessonSummary.jsx), shown between the
 * click and the model's first streamed chunk. Ragged lines, because a summary is
 * a short block of prose or bullets and we don't know how long it will be.
 */
export function SummarySkeleton() {
  return (
    <Box>
      <Skeleton variant="text" width="92%" />
      <Skeleton variant="text" width="85%" />
      <Skeleton variant="text" width="60%" />
    </Box>
  );
}

// A single commit placeholder for the version-history timeline: the dot on the
// rail, then the summary line and a shorter meta line beside it.
function CommitSkeleton() {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ py: 1 }}>
      <Skeleton variant="circular" width={12} height={12} sx={{ mt: 0.75 }} />
      <Box sx={{ flexGrow: 1 }}>
        <Skeleton variant="text" width="70%" />
        <Skeleton variant="text" width="40%" />
      </Box>
    </Stack>
  );
}

/**
 * A stack of placeholder commits, shown while a lesson's history is read out of
 * its git repository (HistoryDialog). Mirrors the real timeline rows, dot and all.
 */
export function HistorySkeleton({ count = 5 }) {
  return (
    <Stack spacing={0.5}>
      {Array.from({ length: count }, (_, i) => (
        <CommitSkeleton key={i} />
      ))}
    </Stack>
  );
}

/**
 * A short stack of single-line placeholders, for the moderation panels' simple row
 * lists (bans, shadowbanned lessons, pending requests, moderators).
 */
export function ListRowsSkeleton({ count = 3 }) {
  return (
    <Stack spacing={1.5}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} variant="text" width={`${85 - i * 10}%`} />
      ))}
    </Stack>
  );
}
