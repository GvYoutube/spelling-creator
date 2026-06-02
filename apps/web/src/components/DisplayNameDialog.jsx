// A small dialog for choosing a public display name — the name shown to other
// users in place of an email. Used in two ways:
//   - forced (required): the gate renders it with no close affordance so a new
//     user must pick a name before using the app (see DisplayNameGate.jsx);
//   - optional (editable): the account menu opens it to change an existing name.
// Saving goes through the Worker (lib/profile.setDisplayName), which validates the
// name and stores it; on success we refresh the session so `user` reflects it.

import { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import { useAuth } from "../lib/auth.jsx";
import {
  setDisplayName,
  DISPLAY_NAME_MIN,
  DISPLAY_NAME_MAX,
} from "../lib/profile.js";

/**
 * @param {object}   props
 * @param {boolean}  props.open      Whether the dialog is shown.
 * @param {boolean}  [props.required] When true, the dialog can't be dismissed and
 *                                    presents a first-time "choose a name" framing.
 * @param {() => void} [props.onClose] Dismiss handler; omitted/ignored when required.
 */
export default function DisplayNameDialog({ open, required = false, onClose }) {
  const { accessToken, displayName, refreshSession } = useAuth();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Seed the field with the current name (when editing) each time it opens.
  useEffect(() => {
    if (open) {
      setName(displayName || "");
      setError("");
    }
  }, [open, displayName]);

  const trimmed = name.replace(/\s+/g, " ").trim();
  const tooShort = trimmed.length < DISPLAY_NAME_MIN;
  const tooLong = trimmed.length > DISPLAY_NAME_MAX;

  const save = async (e) => {
    e.preventDefault();
    setError("");
    if (tooShort || tooLong) return;
    setSaving(true);
    try {
      await setDisplayName(trimmed, accessToken);
      // Pull the new metadata into the session so the gate closes / UI updates.
      await refreshSession();
      if (!required && onClose) onClose();
    } catch (err) {
      setError(err.message || "Could not save your display name.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={required ? undefined : onClose}
      disableEscapeKeyDown={required}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle>
        {required ? "Choose a display name" : "Edit display name"}
      </DialogTitle>
      <Stack component="form" onSubmit={save}>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            This is the name other people see on your lessons and comments. Your
            email address is never shown.
          </DialogContentText>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <TextField
            autoFocus
            fullWidth
            label="Display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            inputProps={{ maxLength: DISPLAY_NAME_MAX }}
            helperText={`${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters.`}
          />
        </DialogContent>
        <DialogActions>
          {!required && (
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button
            type="submit"
            variant="contained"
            disabled={saving || tooShort || tooLong}
            startIcon={
              saving ? (
                <CircularProgress size={16} color="inherit" />
              ) : undefined
            }
          >
            Save
          </Button>
        </DialogActions>
      </Stack>
    </Dialog>
  );
}
