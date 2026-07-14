// The lesson's version history: every commit its repository holds, newest first,
// and what each one changed — expressed in blocks, not in files or diff hunks.
//
// The user never sees git. They see "Edit 1 question, add 1 image", a time, and a
// button to go back to that version. What makes that possible is the repo layout
// (one file per block, named by its id — see lib/git/layout.js): the change
// between two commits is recoverable exactly, per block, without guessing.

import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CallMergeIcon from "@mui/icons-material/CallMerge";
import HistoryIcon from "@mui/icons-material/History";
import RestoreIcon from "@mui/icons-material/Restore";
import { HistorySkeleton } from "./Skeletons.jsx";
import { describeOp } from "../lib/git/ops.js";

/** "just now" / "12 minutes ago" / "3 days ago" — then fall back to a date. */
export function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 45) return "just now";

  const units = [
    ["minute", 60],
    ["hour", 60],
    ["day", 24],
  ];
  let value = seconds / 60;
  let unit = "minute";
  for (let i = 0; i < units.length - 1; i++) {
    if (value < units[i + 1][1]) break;
    value /= units[i + 1][1];
    unit = units[i + 1][0];
  }
  const rounded = Math.floor(value);
  if (unit === "day" && rounded > 6) {
    return new Date(ts).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    });
  }
  return `${rounded} ${unit}${rounded === 1 ? "" : "s"} ago`;
}

// The counts badged against a commit, derived from its ops.
function tally(ops) {
  const counts = { added: 0, edited: 0, removed: 0, moved: 0 };
  for (const op of ops) {
    if (op.op === "block.add") counts.added++;
    else if (op.op === "block.edit") counts.edited++;
    else if (op.op === "block.remove") counts.removed++;
    else if (op.op === "block.move") counts.moved++;
  }
  return counts;
}

function ChangeChips({ ops }) {
  const counts = tally(ops);
  const chips = [
    ["added", counts.added, "success"],
    ["changed", counts.edited, "info"],
    ["removed", counts.removed, "error"],
    ["moved", counts.moved, "default"],
  ].filter(([, n]) => n > 0);

  if (chips.length === 0) return null;
  return (
    <Stack
      direction="row"
      spacing={0.5}
      sx={{ mt: 0.5 }}
      flexWrap="wrap"
      useFlexGap
    >
      {chips.map(([label, n, color]) => (
        <Chip
          key={label}
          size="small"
          variant="outlined"
          color={color}
          label={`${n} ${label}`}
        />
      ))}
    </Stack>
  );
}

/**
 * @param {object}   props.git       The useLessonGit controller.
 * @param {Function} props.onRestore Called with the restored doc; the editor adopts it.
 */
export default function HistoryDialog({ open, onClose, git, onRestore }) {
  const [commits, setCommits] = useState(null); // null = still loading
  const [selected, setSelected] = useState(null); // oid
  const [detail, setDetail] = useState(null); // ops of the selected commit
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState(null);

  const { loadHistory, diffFor, restore, pending } = git;

  // Re-read the history each time the dialog opens: the editor has very likely
  // committed since it was last closed.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setCommits(null);
    setSelected(null);
    setDetail(null);
    setError(null);

    loadHistory().then((list) => {
      if (cancelled) return;
      setCommits(list);
      if (list.length > 0) setSelected(list[0].oid);
    });

    return () => {
      cancelled = true;
    };
  }, [open, loadHistory]);

  // What the selected commit changed, against its first parent.
  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;

    setDetail(null);
    diffFor(selected).then((ops) => {
      if (!cancelled) setDetail(ops);
    });

    return () => {
      cancelled = true;
    };
  }, [open, selected, diffFor]);

  const handleRestore = useCallback(async () => {
    if (!selected) return;
    setRestoring(true);
    setError(null);
    try {
      const doc = await restore(selected);
      onRestore(doc);
      onClose();
    } catch (err) {
      setError(err.message || "Could not restore that version.");
    } finally {
      setRestoring(false);
    }
  }, [selected, restore, onRestore, onClose]);

  const isCurrent = commits && selected === commits[0]?.oid;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <HistoryIcon fontSize="small" />
          <span>Version history</span>
        </Stack>
      </DialogTitle>

      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {pending > 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You have {pending} change{pending === 1 ? "" : "s"} since the last
            saved version. They&apos;ll be saved automatically in a moment.
          </Alert>
        )}

        {commits === null ? (
          <HistorySkeleton />
        ) : commits.length === 0 ? (
          <Typography color="text.secondary">
            No versions saved yet. Edit the lesson and a version is saved
            automatically whenever you pause.
          </Typography>
        ) : (
          <Grid container spacing={2}>
            {/* The timeline. */}
            <Grid size={{ xs: 12, md: 5 }}>
              <List
                dense
                disablePadding
                sx={{ maxHeight: 420, overflowY: "auto" }}
              >
                {commits.map((commit, i) => (
                  <ListItemButton
                    key={commit.oid}
                    selected={commit.oid === selected}
                    onClick={() => setSelected(commit.oid)}
                    sx={{ borderRadius: 1, mb: 0.5, alignItems: "flex-start" }}
                  >
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Stack direction="row" alignItems="center" spacing={0.75}>
                        {commit.isMerge && (
                          <Tooltip title="A merge — two histories joined here">
                            <CallMergeIcon
                              fontSize="inherit"
                              color="secondary"
                            />
                          </Tooltip>
                        )}
                        <Typography
                          variant="body2"
                          sx={{ fontWeight: i === 0 ? 600 : 400 }}
                          noWrap
                        >
                          {commit.summary}
                        </Typography>
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {i === 0 ? "Current · " : ""}
                        {timeAgo(commit.timestamp)} · {commit.author}
                      </Typography>
                    </Box>
                  </ListItemButton>
                ))}
              </List>
            </Grid>

            {/* What that version changed. */}
            <Grid size={{ xs: 12, md: 7 }}>
              <Paper variant="outlined" sx={{ p: 2, minHeight: 200 }}>
                {detail === null ? (
                  <HistorySkeleton count={3} />
                ) : detail.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    This is where the lesson began.
                  </Typography>
                ) : (
                  <>
                    <Typography variant="subtitle2" gutterBottom>
                      What changed
                    </Typography>
                    <ChangeChips ops={detail} />
                    <Divider sx={{ my: 1.5 }} />
                    <Stack
                      component="ul"
                      spacing={0.5}
                      sx={{ m: 0, pl: 2, maxHeight: 260, overflowY: "auto" }}
                    >
                      {detail.map((op, i) => (
                        <Typography
                          key={i}
                          component="li"
                          variant="body2"
                          color="text.secondary"
                        >
                          {/* describeOp renders "- edit text block <id>"; drop the
                              leading marker, the list already provides one. */}
                          {describeOp(op).replace(/^- /, "")}
                        </Typography>
                      ))}
                    </Stack>
                  </>
                )}
              </Paper>
            </Grid>
          </Grid>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          startIcon={<RestoreIcon />}
          disabled={
            !selected || restoring || isCurrent || commits?.length === 0
          }
          onClick={handleRestore}
        >
          {isCurrent ? "This is the current version" : "Restore this version"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
