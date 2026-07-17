import { useEffect, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.jsx";
import { Button } from "./ui/button.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { Spinner } from "./ui/spinner.jsx";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select.jsx";
import { Field, FieldLabel } from "./ui/field.jsx";
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose?.();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Suggest a question with AI</DialogTitle>
          <DialogDescription>
            {subject ? (
              <>
                Generate a question for the section{" "}
                <strong className="font-medium text-foreground">
                  “{subject}”
                </strong>
                .
              </>
            ) : (
              "Give this section a name first, that's what the question will be about."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="question-type">Question type</FieldLabel>
            <Select
              value={questionType}
              onValueChange={setQuestionType}
              disabled={busy}
            >
              <SelectTrigger id="question-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUESTION_TYPE_LIST.map((q) => (
                  <SelectItem key={q.key} value={q.key}>
                    <span
                      className="inline-block size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: q.color }}
                    />
                    <span className="flex flex-col">
                      <span>{q.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {q.description}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div ref={widgetRef} className="min-h-[65px]" />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleGenerate}
            disabled={busy || !token || !subject}
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            {busy ? "Generating…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
