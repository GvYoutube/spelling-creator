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
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ThumbDownAltOutlinedIcon from "@mui/icons-material/ThumbDownAltOutlined";
import { suggestText, dislikeText } from "../lib/aiSuggest.js";
import { useAuth } from "../lib/auth.jsx";
import { TURNSTILE_SITE_KEY, whenTurnstileReady } from "../lib/turnstile.js";

/**
 * Dialog that generates a block of lesson text via the Worker. The subject is
 * the section title the user already typed, so there is no separate input to
 * fill in here. It renders a Cloudflare Turnstile widget; the verified token it
 * produces is sent with the request so the Worker can confirm the call came
 * from our domain.
 *
 * The generated text is shown for review before it is inserted. A signed-in
 * user can "thumbs down" a suggestion: that evicts it from the Worker's cache
 * (see lib/aiSuggest.dislikeText) so the same subject regenerates a fresh
 * answer instead of serving the disliked one. Disliking then offers an
 * immediate regenerate from the freshly-cleared cache.
 */
export default function AiTextDialog({
  open,
  sectionTitle,
  documentName,
  onInsert,
  onClose,
}) {
  const { user, accessToken } = useAuth();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The generated text awaiting review, and whether it has been disliked
  // (cache evicted) so the UI can offer a fresh regenerate.
  const [result, setResult] = useState("");
  const [disliked, setDisliked] = useState(false);
  const [dislikeBusy, setDislikeBusy] = useState(false);
  const widgetRef = useRef(null);
  const widgetIdRef = useRef(null);

  const subject = (sectionTitle || "").trim();
  const working = busy || dislikeBusy;

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setToken("");
      setError("");
      setBusy(false);
      setResult("");
      setDisliked(false);
      setDislikeBusy(false);
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
    if (!subject) {
      setError("Give this section a name first, then try again.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const text = await suggestText(subject, token, { documentName });
      setResult(text);
      setDisliked(false);
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      // Spend the token either way: it is consumed once submitted.
      refreshChallenge();
      setBusy(false);
    }
  };

  const handleDislike = async () => {
    setDislikeBusy(true);
    setError("");
    try {
      await dislikeText(subject, accessToken, { documentName });
      setDisliked(true);
    } catch (e) {
      setError(e.message || "Could not remove that suggestion.");
    } finally {
      setDislikeBusy(false);
    }
  };

  const handleInsert = () => {
    onInsert(result);
    onClose();
  };

  // Why the thumbs-down is unavailable, if it is — drives the tooltip and the
  // disabled state. Signing in is required because the action mutates the
  // shared server cache on behalf of an account.
  const dislikeReason = !user
    ? "Sign in to remove this suggestion from the cache"
    : disliked
      ? "Removed from the cache"
      : "Not a good suggestion? Remove it from the cache";

  return (
    <Dialog
      open={open}
      onClose={working ? undefined : onClose}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle>Suggest text with AI</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <DialogContentText>
            {subject ? (
              <>
                Generate a block of text for the section{" "}
                <strong>“{subject}”</strong>.
              </>
            ) : (
              "Give this section a name first, that's what the text will be about."
            )}
          </DialogContentText>

          {result && (
            <Box>
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  border: 1,
                  borderColor: "divider",
                  bgcolor: "action.hover",
                  maxHeight: 220,
                  overflowY: "auto",
                  whiteSpace: "pre-wrap",
                  typography: "body2",
                }}
              >
                {result}
              </Box>
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ mt: 1 }}
              >
                <Tooltip title={dislikeReason}>
                  {/* span so the tooltip still shows while the button is disabled */}
                  <span>
                    <IconButton
                      size="small"
                      color={disliked ? "error" : "default"}
                      onClick={handleDislike}
                      disabled={!user || disliked || working}
                      aria-label="Remove this suggestion from the cache"
                    >
                      {dislikeBusy ? (
                        <CircularProgress size={18} color="inherit" />
                      ) : (
                        <ThumbDownAltOutlinedIcon fontSize="small" />
                      )}
                    </IconButton>
                  </span>
                </Tooltip>
                <Typography variant="caption" color="text.secondary">
                  {disliked
                    ? "Removed from the cache — generate a fresh one below."
                    : "Don’t like it? Remove it so the next try is freshly written."}
                </Typography>
              </Stack>
            </Box>
          )}

          {/* The widget powers the initial generate and any regenerate. */}
          <Box ref={widgetRef} sx={{ minHeight: 65 }} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={working}>
          Cancel
        </Button>
        {/* Insert is available once there is a reviewed suggestion. After a
            dislike it is demoted to "Insert anyway" in favour of regenerating. */}
        {result && (
          <Button
            variant={disliked ? "outlined" : "contained"}
            onClick={handleInsert}
            disabled={working}
          >
            {disliked ? "Insert anyway" : "Insert"}
          </Button>
        )}
        {/* Generate the first suggestion, or a fresh one after a dislike. */}
        {(!result || disliked) && (
          <Button
            variant="contained"
            onClick={handleGenerate}
            disabled={working || !token || !subject}
            startIcon={
              busy ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <AutoAwesomeIcon />
              )
            }
          >
            {busy ? "Generating…" : result ? "Generate fresh" : "Generate"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
