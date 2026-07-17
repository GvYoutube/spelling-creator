import { useEffect, useRef, useState } from "react";
import { SparklesIcon, ThumbsDownIcon } from "lucide-react";
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
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import { cn } from "../lib/utils.js";
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
      onOpenChange={(next) => {
        if (!next && !working) onClose?.();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Suggest text with AI</DialogTitle>
          <DialogDescription>
            {subject ? (
              <>
                Generate a block of text for the section{" "}
                <strong className="font-medium text-foreground">
                  “{subject}”
                </strong>
                .
              </>
            ) : (
              "Give this section a name first, that's what the text will be about."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {result && (
            <div>
              <div className="max-h-[220px] overflow-y-auto rounded-md border border-border bg-muted p-3 text-sm whitespace-pre-wrap">
                {result}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* span so the tooltip still shows while the button is disabled */}
                    <span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={cn(disliked && "text-destructive")}
                        onClick={handleDislike}
                        disabled={!user || disliked || working}
                        aria-label="Remove this suggestion from the cache"
                      >
                        {dislikeBusy ? <Spinner /> : <ThumbsDownIcon />}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{dislikeReason}</TooltipContent>
                </Tooltip>
                <span className="text-xs text-muted-foreground">
                  {disliked
                    ? "Removed from the cache — generate a fresh one below."
                    : "Don’t like it? Remove it so the next try is freshly written."}
                </span>
              </div>
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
            disabled={working}
          >
            Cancel
          </Button>
          {/* Insert is available once there is a reviewed suggestion. After a
              dislike it is demoted to "Insert anyway" in favour of regenerating. */}
          {result && (
            <Button
              type="button"
              variant={disliked ? "outline" : "default"}
              onClick={handleInsert}
              disabled={working}
            >
              {disliked ? "Insert anyway" : "Insert"}
            </Button>
          )}
          {/* Generate the first suggestion, or a fresh one after a dislike. */}
          {(!result || disliked) && (
            <Button
              type="button"
              onClick={handleGenerate}
              disabled={working || !token || !subject}
            >
              {busy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SparklesIcon data-icon="inline-start" />
              )}
              {busy ? "Generating…" : result ? "Generate fresh" : "Generate"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
