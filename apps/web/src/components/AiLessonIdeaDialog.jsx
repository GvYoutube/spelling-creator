import { useEffect, useRef, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import DialogContentText from "@mui/material/DialogContentText";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Alert from "@mui/material/Alert";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { suggestLessonIdeas } from "../lib/aiSuggest.js";
import { TURNSTILE_SITE_KEY, whenTurnstileReady } from "../lib/turnstile.js";

/**
 * Dialog that suggests lesson topic ideas for the lesson's age range via the
 * Worker. It renders a Cloudflare Turnstile widget; the verified token it
 * produces is sent with the request so the Worker can confirm the call came
 * from our domain.
 *
 * Suggestions are listed for review; picking one calls `onSelect` with its
 * title (the editor adopts it as the lesson title). The age range is shown so
 * the user knows what the ideas are tailored to, and is sent to the Worker to
 * pitch the topics appropriately.
 */
export default function AiLessonIdeaDialog({
  open,
  ageRange,
  onSelect,
  onClose,
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ideas, setIdeas] = useState([]);
  const widgetRef = useRef(null);
  const widgetIdRef = useRef(null);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setToken("");
      setError("");
      setBusy(false);
      setIdeas([]);
    }
  }, [open]);

  // Mount the Turnstile widget while the dialog is open; tear it down on close.
  useEffect(() => {
    if (!open) return;
    if (!TURNSTILE_SITE_KEY) {
      setError("VITE_TURNSTILE_SITE_KEY is not configured.");
      return;
    }

    let cancelled = false;

    whenTurnstileReady()
      .then((turnstile) => {
        if (cancelled || !widgetRef.current) return;
        widgetIdRef.current = turnstile.render(widgetRef.current, {
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
      if (widgetIdRef.current != null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [open]);

  // The Turnstile token is single-use, so refresh the widget after each AI call
  // to have a fresh one ready for a possible regenerate.
  const refreshChallenge = () => {
    setToken("");
    if (widgetIdRef.current != null && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  };

  const handleGenerate = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await suggestLessonIdeas(ageRange, token);
      setIdeas(next);
      if (!next.length) {
        setError("No ideas came back — try generating again.");
      }
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      // Spend the token either way: it is consumed once submitted.
      refreshChallenge();
      setBusy(false);
    }
  };

  const handlePick = (idea) => {
    onSelect(idea.title);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>Suggest lesson ideas with AI</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <DialogContentText component="div">
            {ageRange ? (
              <>
                Ideas for lessons aimed at{" "}
                <Chip size="small" label={ageRange} sx={{ mx: 0.25 }} />.
              </>
            ) : (
              "Set an age range above to tailor the ideas, or generate general ideas now."
            )}{" "}
            Pick one to use it as your lesson title.
          </DialogContentText>

          {ideas.length > 0 && (
            <Stack spacing={1}>
              {ideas.map((idea, i) => (
                <Box
                  key={i}
                  onClick={() => handlePick(idea)}
                  sx={{
                    p: 1.5,
                    borderRadius: 1,
                    border: 1,
                    borderColor: "divider",
                    cursor: "pointer",
                    "&:hover": {
                      borderColor: "primary.main",
                      bgcolor: "action.hover",
                    },
                  }}
                >
                  <Typography variant="subtitle2">{idea.title}</Typography>
                  {idea.description && (
                    <Typography variant="body2" color="text.secondary">
                      {idea.description}
                    </Typography>
                  )}
                </Box>
              ))}
            </Stack>
          )}

          {/* The widget powers the initial generate and any regenerate. */}
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
          disabled={busy || !token}
          startIcon={
            busy ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <AutoAwesomeIcon />
            )
          }
        >
          {busy ? "Generating…" : ideas.length ? "Generate more" : "Generate"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
