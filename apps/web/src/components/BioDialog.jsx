// A small dialog for editing your public bio — the "about me" shown on your
// profile page. Mirrors DisplayNameDialog: saving goes through the Worker
// (lib/profile.setBio), which validates length and profanity before storing it in
// user_metadata; on success we refresh the session so `user` reflects the change.

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
import { setBio, BIO_MAX } from "../lib/profile.js";

/**
 * @param {object}     props
 * @param {boolean}    props.open       Whether the dialog is shown.
 * @param {string}     [props.initial]  The current bio to seed the field with.
 * @param {() => void} [props.onClose]  Dismiss handler.
 * @param {(bio: string) => void} [props.onSaved]  Called with the saved bio so the
 *                                       profile page can update without a refetch.
 */
export default function BioDialog({ open, initial = "", onClose, onSaved }) {
  const { accessToken, refreshSession } = useAuth();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Seed the field with the current bio each time it opens.
  useEffect(() => {
    if (open) {
      setText(initial || "");
      setError("");
    }
  }, [open, initial]);

  const trimmed = text.trim();
  const tooLong = trimmed.length > BIO_MAX;

  const save = async (e) => {
    e.preventDefault();
    setError("");
    if (tooLong) return;
    setSaving(true);
    try {
      const saved = await setBio(trimmed, accessToken);
      // Pull the new metadata into the session so the UI reflects it elsewhere.
      await refreshSession();
      if (onSaved) onSaved(saved);
      if (onClose) onClose();
    } catch (err) {
      setError(err.message || "Could not save your bio.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Edit bio</DialogTitle>
      <Stack component="form" onSubmit={save}>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            A short description shown on your public profile. Leave it empty to
            remove your bio.
          </DialogContentText>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label="Bio"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={saving}
            inputProps={{ maxLength: BIO_MAX }}
            error={tooLong}
            helperText={`${trimmed.length}/${BIO_MAX} characters.`}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={saving || tooLong}
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
