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
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import ListItemText from "@mui/material/ListItemText";
import CircularProgress from "@mui/material/CircularProgress";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { suggestQuestion } from "../lib/aiSuggest.js";
import { QUESTION_TYPE_LIST } from "../lib/questions.js";
import { TURNSTILE_SITE_KEY, whenTurnstileReady } from "../lib/turnstile.js";

/**
 * Dialog that suggests a quiz question via the Worker, alongside the text
 * suggester. The subject is the section title the user already typed; the user
 * only picks which type of question to generate. Like AiTextDialog, it renders
 * a Cloudflare Turnstile widget and sends the verified token with the request
 * so the Worker can confirm the call came from our domain. The section's
 * existing text is sent as context so the question is grounded in the lesson.
 * The prompts of any questions already in the section are sent too, so the model
 * can avoid repeating one the user already has.
 */
export default function AiQuestionDialog({
  open,
  sectionTitle,
  documentName,
  sectionText,
  existingQuestions,
  onInsert,
  onClose,
}) {
  const [questionType, setQuestionType] = useState("single");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const widgetRef = useRef(null);

  const subject = (sectionTitle || "").trim();

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setToken("");
      setError("");
      setBusy(false);
      setQuestionType("single");
    }
  }, [open]);

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
    if (!subject) {
      setError("Give this section a name first, then try again.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await suggestQuestion(subject, token, {
        questionType,
        documentName,
        sectionText,
        existingQuestions,
      });
      onInsert(questionType, data);
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
      <DialogTitle>Suggest a question with AI</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <DialogContentText>
            {subject
              ? <>Generate a question for the section <strong>“{subject}”</strong>.</>
              : "Give this section a name first, that's what the question will be about."}
          </DialogContentText>
          <TextField
            select
            label="Question type"
            value={questionType}
            onChange={(e) => setQuestionType(e.target.value)}
            disabled={busy}
            fullWidth
            size="small"
          >
            {QUESTION_TYPE_LIST.map((q) => (
              <MenuItem key={q.key} value={q.key}>
                <Box
                  component="span"
                  sx={{
                    display: "inline-block",
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    bgcolor: q.color,
                    mr: 1.5,
                    flexShrink: 0,
                  }}
                />
                <ListItemText
                  primary={q.label}
                  secondary={q.description}
                  sx={{ my: 0 }}
                />
              </MenuItem>
            ))}
          </TextField>
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
          disabled={busy || !token || !subject}
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
