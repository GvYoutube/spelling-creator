// Settling a merge.
//
// Most of a merge needs no input: a block only one side touched is taken from
// that side, and a block both sides touched in *different fields* — one changed
// the caption, the other the width — is merged field by field so both edits
// survive. That happens silently, and is reported here as a summary.
//
// What's left is the genuinely contested: the same field of the same block, given
// two different values by two people. No rule can pick between those, so we ask.
// One card per contested block, both values side by side, three ways out:
//
//   Mine        keep our value
//   Theirs      take the original's
//   Keep both   keep ours AND add theirs as a second block (nothing is lost)
//
// See lib/git/merge.js for the merge itself; this component only chooses.

import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import CallMergeIcon from "@mui/icons-material/CallMerge";
import { questionMeta } from "../lib/questions.js";

/** A contested value, rendered readably whatever shape it has. */
function ValueText({ value }) {
  if (value === null || value === undefined || value === "") {
    return (
      <Typography variant="body2" color="text.disabled" fontStyle="italic">
        (empty)
      </Typography>
    );
  }
  if (Array.isArray(value)) {
    // Spelling words and multiple-choice answers are [{ id, text }].
    const items = value.map((v) => (v && typeof v === "object" ? v.text : v));
    return <Typography variant="body2">{items.join(", ")}</Typography>;
  }
  if (typeof value === "object") {
    return (
      <Typography
        variant="body2"
        sx={{ fontFamily: "monospace", fontSize: 12 }}
      >
        {JSON.stringify(value)}
      </Typography>
    );
  }
  return <Typography variant="body2">{String(value)}</Typography>;
}

/** A human name for the block a conflict is about. */
function blockLabel(block) {
  if (!block) return "block";
  if (block.type === "question") {
    return `${questionMeta(block.questionType).short} question`;
  }
  if (block.type === "spelling") return "spelling list";
  if (block.type === "image") return "image";
  return "text block";
}

// One side of a contested field, in a tinted panel.
function Side({ label, value, chosen }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        flex: 1,
        minWidth: 0,
        borderColor: chosen ? "primary.main" : "divider",
        bgcolor: chosen ? "action.selected" : "transparent",
      }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mb: 0.5 }}
      >
        {label}
      </Typography>
      <ValueText value={value} />
    </Paper>
  );
}

function ConflictCard({ conflict, choice, onChoose, theirName }) {
  const block = conflict.ours || conflict.theirs;
  const deleted = conflict.kind === "delete/edit";

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{ mb: 1.5 }}
        flexWrap="wrap"
        useFlexGap
      >
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="subtitle2">{blockLabel(block)}</Typography>
          <Chip
            size="small"
            variant="outlined"
            color={deleted ? "warning" : "default"}
            label={
              deleted
                ? conflict.deletedBy === "theirs"
                  ? `deleted in ${theirName}`
                  : "you deleted this"
                : conflict.fields.map((f) => f.field).join(", ")
            }
          />
        </Stack>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={choice}
          onChange={(_, next) => next && onChoose(next)}
        >
          <ToggleButton value="ours">
            {deleted ? "Keep it" : "Mine"}
          </ToggleButton>
          <ToggleButton value="theirs">
            {deleted ? "Delete it" : "Theirs"}
          </ToggleButton>
          {!deleted && <ToggleButton value="both">Keep both</ToggleButton>}
        </ToggleButtonGroup>
      </Stack>

      {deleted ? (
        <Typography variant="body2" color="text.secondary">
          {conflict.deletedBy === "theirs"
            ? `You edited this block; ${theirName} deleted it. Keeping it preserves your edit.`
            : `You deleted this block; ${theirName} edited it. Keeping it restores their version.`}
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {conflict.fields.map((field) => (
            <Box key={field.field}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mb: 0.5 }}
              >
                {field.field}
              </Typography>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                <Side
                  label="Mine"
                  value={field.ours}
                  chosen={choice === "ours" || choice === "both"}
                />
                <Side
                  label={theirName}
                  value={field.theirs}
                  chosen={choice === "theirs" || choice === "both"}
                />
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

/**
 * @param {object}   props.prepared  The result of prepareUpstreamMerge (doc, conflicts, auto).
 * @param {string}   props.theirName What to call the other side (the original lesson's title).
 * @param {Function} props.onConfirm Called with the { blockId: choice } map.
 */
export default function MergeDialog({
  open,
  onClose,
  prepared,
  theirName = "the original",
  onConfirm,
  busy,
}) {
  // Default every conflict to keeping our own work — the safe assumption is that
  // the user's own edits stand unless they say otherwise.
  const [choices, setChoices] = useState({});

  if (!prepared) return null;
  const { conflicts, auto } = prepared;

  const choiceFor = (blockId) => choices[blockId] || "ours";
  const choose = (blockId, value) =>
    setChoices((prev) => ({ ...prev, [blockId]: value }));

  const autoCount =
    auto.added.length +
    auto.tookTheirs.length +
    auto.merged.length +
    auto.removed.length;

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CallMergeIcon fontSize="small" />
          <span>Merge changes from {theirName}</span>
        </Stack>
      </DialogTitle>

      <DialogContent dividers>
        {autoCount > 0 && (
          <Alert severity="success" sx={{ mb: 2 }}>
            <Typography variant="body2" component="div">
              Merged automatically:
              <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
                {auto.added.length > 0 && (
                  <li>
                    {auto.added.length} new block(s) from {theirName}
                  </li>
                )}
                {auto.tookTheirs.length > 0 && (
                  <li>
                    {auto.tookTheirs.length} block(s) they updated (you
                    hadn&apos;t touched)
                  </li>
                )}
                {auto.merged.length > 0 && (
                  <li>
                    {auto.merged.length} block(s) you both edited — in different
                    fields, so <strong>both sets of edits were kept</strong>
                  </li>
                )}
                {auto.removed.length > 0 && (
                  <li>{auto.removed.length} block(s) removed</li>
                )}
              </Box>
            </Typography>
          </Alert>
        )}

        {conflicts.length === 0 ? (
          <Alert severity="info">
            Nothing is in conflict — the whole merge resolved on its own.
            Confirm to apply it.
          </Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {conflicts.length === 1
                ? "One block was edited on both sides in the same place. Choose which to keep."
                : `${conflicts.length} blocks were edited on both sides in the same place. Choose which to keep.`}
            </Typography>
            <Stack spacing={2}>
              {conflicts.map((conflict) => (
                <ConflictCard
                  key={conflict.blockId}
                  conflict={conflict}
                  choice={choiceFor(conflict.blockId)}
                  onChoose={(value) => choose(conflict.blockId, value)}
                  theirName={theirName}
                />
              ))}
            </Stack>
          </>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          startIcon={<CallMergeIcon />}
          onClick={() => onConfirm(choices)}
          disabled={busy}
        >
          {busy ? "Merging..." : "Merge"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
