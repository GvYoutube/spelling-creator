import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
import { suggestText, dislikeText } from "@spelling-creator/core/aiSuggest";
import { useAuth } from "../lib/auth.jsx";
import { turnstileSiteKey } from "@spelling-creator/core/config";
import { whenTurnstileReady } from "@spelling-creator/core/browser/turnstile";

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
  const { t } = useTranslation("aiDialogs");

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
    if (!turnstileSiteKey()) {
      setError(t("aiText.turnstileNotConfigured"));
      return;
    }

    let cancelled = false;

    whenTurnstileReady()
      .then((turnstile) => {
        if (cancelled || !widgetRef.current) return;
        widgetIdRef.current = turnstile.render(widgetRef.current, {
          sitekey: turnstileSiteKey(),
          callback: (tok) => setToken(tok),
          "expired-callback": () => setToken(""),
          "error-callback": () => {
            setToken("");
            setError(t("aiText.verificationFailed"));
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
  }, [open, t]);

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
      setError(t("aiText.nameSectionFirst"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const text = await suggestText(subject, token, { documentName });
      setResult(text);
      setDisliked(false);
    } catch (e) {
      setError(e.message || t("aiText.genericError"));
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
      setError(e.message || t("aiText.dislikeFailed"));
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
    ? t("aiText.dislikeReasonSignedOut")
    : disliked
      ? t("aiText.dislikeReasonDisliked")
      : t("aiText.dislikeReasonDefault");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !working) onClose?.();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("aiText.title")}</DialogTitle>
          <DialogDescription>
            {subject ? (
              <Trans
                i18nKey="aiText.descriptionWithSubject"
                ns="aiDialogs"
                values={{ subject }}
                components={{
                  strong: <strong className="font-medium text-foreground" />,
                }}
              />
            ) : (
              t("aiText.descriptionNoSubject")
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
                        aria-label={t("aiText.dislikeAriaLabel")}
                      >
                        {dislikeBusy ? <Spinner /> : <ThumbsDownIcon />}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{dislikeReason}</TooltipContent>
                </Tooltip>
                <span className="text-xs text-muted-foreground">
                  {disliked
                    ? t("aiText.helperDisliked")
                    : t("aiText.helperDefault")}
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
            {t("aiText.cancel")}
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
              {disliked ? t("aiText.insertAnyway") : t("aiText.insert")}
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
              {busy
                ? t("aiText.generating")
                : result
                  ? t("aiText.generateFresh")
                  : t("aiText.generate")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
