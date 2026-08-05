// MCP OAuth consent screen — reached via a redirect from the Worker's
// GET /authorize (see apps/api/src/routes/oauth.js) after an MCP client (e.g.
// claude.ai, Claude Desktop) sends the user's browser here to approve a
// connection. An ordinary page of this app: if the user isn't signed in yet,
// it offers the same magic-link sign-in as /login (routed back here via
// `state`, so the flow resumes exactly where it left off); once signed in, it
// shows what the connecting client is asking for and lets the user approve or
// deny — no token is ever shown or copied by hand.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LockOpenIcon, MailCheckIcon } from "lucide-react";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Field, FieldLabel } from "../components/ui/field.jsx";
import { Alert, AlertDescription } from "../components/ui/alert.jsx";
import { Separator } from "../components/ui/separator.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";
import { Spinner } from "../components/ui/spinner.jsx";
import { useAuth } from "../lib/auth.jsx";
import {
  fetchOAuthRequest,
  approveOAuthRequest,
} from "@spelling-creator/core/mcpOAuth";
import { useDocumentMeta } from "../lib/seo.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function OAuthAuthorizePage() {
  const { t } = useTranslation("oauth");
  useDocumentMeta({ title: t("pageTitle") });
  const [searchParams] = useSearchParams();
  const state = searchParams.get("state") || "";
  const { enabled, loading, user, session, displayName, signInWithMagicLink } =
    useAuth();

  const [reqInfo, setReqInfo] = useState(null);
  const [reqError, setReqError] = useState("");
  const [reqLoading, setReqLoading] = useState(true);

  useEffect(() => {
    let active = true;
    if (!state) {
      setReqError(t("errors.missingRequest"));
      setReqLoading(false);
      return;
    }
    fetchOAuthRequest(state)
      .then((info) => {
        if (active) setReqInfo(info);
      })
      .catch((err) => {
        if (active) setReqError(err.message);
      })
      .finally(() => {
        if (active) setReqLoading(false);
      });
    return () => {
      active = false;
    };
  }, [state, t]);

  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [signInError, setSignInError] = useState("");

  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState("");

  const sendMagicLink = async (e) => {
    e.preventDefault();
    setSignInError("");
    if (!EMAIL_RE.test(email.trim())) {
      setSignInError(t("errors.invalidEmail"));
      return;
    }
    setSending(true);
    try {
      // Bring the user back to this exact page (with the same request still
      // pending) once they click the emailed link, instead of the site root.
      const redirectTo = `${window.location.origin}/oauth/authorize?state=${encodeURIComponent(state)}`;
      await signInWithMagicLink(email.trim(), redirectTo);
      setSent(true);
    } catch (err) {
      setSignInError(err.message || t("errors.magicLinkFailed"));
    } finally {
      setSending(false);
    }
  };

  const approve = async () => {
    setDecideError("");
    setDeciding(true);
    try {
      const redirectTo = await approveOAuthRequest(
        state,
        session.access_token,
        session.refresh_token,
      );
      window.location.href = redirectTo;
    } catch (err) {
      setDecideError(err.message || t("errors.approveFailed"));
      setDeciding(false);
    }
  };

  const deny = () => {
    if (!reqInfo) return;
    const url = new URL(reqInfo.redirectUri);
    url.searchParams.set("error", "access_denied");
    if (reqInfo.clientState) url.searchParams.set("state", reqInfo.clientState);
    window.location.href = url.toString();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-panel border border-border bg-card p-8 text-card-foreground shadow-(--shadow-panel)">
        {!enabled ? (
          <Alert>
            <AlertDescription>
              {t("errors.signInNotConfigured")}
            </AlertDescription>
          </Alert>
        ) : reqLoading || loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-7 w-[70%]" />
            <Skeleton className="h-4 w-[90%]" />
            <Skeleton className="h-4 w-[80%]" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ) : reqError ? (
          <Alert variant="destructive">
            <AlertDescription>{reqError}</AlertDescription>
          </Alert>
        ) : !user ? (
          <form onSubmit={sendMagicLink} className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <LockOpenIcon className="size-10 text-primary" />
              <h1 className="text-lg font-semibold">{t("signIn.heading")}</h1>
              <p className="text-sm text-muted-foreground">
                <strong className="font-medium text-foreground">
                  {reqInfo.clientName}
                </strong>{" "}
                {t("signIn.description")}
              </p>
            </div>
            {sent ? (
              <Alert>
                <MailCheckIcon />
                <AlertDescription>{t("signIn.checkEmail")}</AlertDescription>
              </Alert>
            ) : (
              <>
                {signInError && (
                  <Alert variant="destructive">
                    <AlertDescription>{signInError}</AlertDescription>
                  </Alert>
                )}
                <Field>
                  <FieldLabel htmlFor="oauth-email">
                    {t("signIn.emailLabel")}
                  </FieldLabel>
                  <Input
                    id="oauth-email"
                    autoFocus
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={sending}
                  />
                </Field>
                <Button type="submit" disabled={sending}>
                  {sending && <Spinner data-icon="inline-start" />}
                  {t("signIn.sendButton")}
                </Button>
              </>
            )}
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <LockOpenIcon className="size-10 text-primary" />
              <h1 className="text-lg font-semibold">
                {t("consent.heading", { clientName: reqInfo.clientName })}
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("consent.signedInAs")}{" "}
              <strong className="font-medium text-foreground">
                {displayName || user.email}
              </strong>
              {t("consent.willLet")}{" "}
              <strong className="font-medium text-foreground">
                {reqInfo.clientName}
              </strong>{" "}
              {t("consent.behalfText")}
            </p>
            <Separator />
            {decideError && (
              <Alert variant="destructive">
                <AlertDescription>{decideError}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={deny}
                disabled={deciding}
              >
                {t("buttons.deny")}
              </Button>
              <Button type="button" onClick={approve} disabled={deciding}>
                {deciding && <Spinner data-icon="inline-start" />}
                {t("buttons.approve")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
