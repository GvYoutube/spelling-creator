import { useEffect, useRef, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { suggestText } from "../lib/aiSuggest.js";
import { TURNSTILE_SITE_KEY, whenTurnstileReady } from "../lib/turnstile.js";

/**
 * Dialog that generates a block of lesson text via the Worker. It renders a
 * Cloudflare Turnstile widget; the verified token it produces is sent with the
 * request so the Worker can confirm the call came from our domain.
 */
export default function AiTextDialog({ open, defaultSubject, onInsert, onClose }) {
  const [subject, setSubject] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const widgetRef = useRef(null);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setSubject(defaultSubject || "");
      setToken("");
      setError("");
      setBusy(false);
    }
  }, [open, defaultSubject]);

  // Mount the Turnstile widget while the dialog is open; tear it down on close.
  useEffect(() => {
    if (!open) return;
    if (!TURNSTILE_SITE_KEY) {
      setError("VITE_TURNSTILE_SITE_KEY is not configured.");
      return;
    }

    let widgetId;
    let cancelled = false;

    whenTurnstileReady()
      .then((turnstile) => {
        if (cancelled || !widgetRef.current) return;
        widgetId = turnstile.render(widgetRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (t) => setToken(t),
          "expired-callback": () => setToken(""),
          "error-callback": () => {
            setToken("");
            setError("Verification failed. Please try again.");
          },
        });
      })
      .catch((e) => setError(e.message));

    return () => {
      cancelled = true;
      if (widgetId != null && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [open]);

  const handleGenerate = async () => {
    const trimmed = subject.trim();
    if (!trimmed) {
      setError("Enter a subject to write about.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const text = await suggestText(trimmed, token);
      onInsert(text);
      onClose();
    } catch (e) {
      setError(e.message || "Something went wrong.");
      // Token is single-use; force a fresh challenge before retrying.
      setToken("");
      if (widgetRef.current && window.turnstile) {
        window.turnstile.reset(widgetRef.current);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Suggest text with AI</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <TextField
            autoFocus
            fullWidth
            label="Subject"
            placeholder="e.g. The water cycle"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && token && !busy) handleGenerate();
            }}
            disabled={busy}
          />
          <Box ref={widgetRef} sx={{ minHeight: 65 }} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleGenerate}
          disabled={busy || !token || !subject.trim()}
          startIcon={
            busy ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <AutoAwesomeIcon />
            )
          }
        >
          {busy ? "Generating…" : "Generate"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
