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
import { Badge } from "./ui/badge.jsx";
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
      onOpenChange={(next) => {
        if (!next && !busy) onClose?.();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Suggest lesson ideas with AI</DialogTitle>
          <DialogDescription>
            {ageRange ? (
              <>
                Ideas for lessons aimed at{" "}
                <Badge variant="secondary" className="align-middle">
                  {ageRange}
                </Badge>
                .
              </>
            ) : (
              "Set an age range above to tailor the ideas, or generate general ideas now."
            )}{" "}
            Pick one to use it as your lesson title.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {ideas.length > 0 && (
            <div className="flex flex-col gap-2">
              {ideas.map((idea, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handlePick(idea)}
                  className="cursor-pointer rounded-md border border-border bg-transparent p-3 text-left transition-colors hover:border-primary hover:bg-accent"
                >
                  <p className="text-sm font-medium">{idea.title}</p>
                  {idea.description && (
                    <p className="text-sm text-muted-foreground">
                      {idea.description}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* The widget powers the initial generate and any regenerate. */}
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
            disabled={busy || !token}
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            {busy ? "Generating…" : ideas.length ? "Generate more" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
