// Login page — passwordless magic-link sign-in via Supabase Auth. The user
// enters their email, we send a one-time link, and Supabase returns them to the
// app root where the client exchanges the callback `?code=` for a session.
//
// Already-signed-in users see their account and a way back to the editor; this
// page never blocks the rest of the app, which works fine while signed out
// (only publishing to the hub requires an account).

import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { PencilIcon, MailCheckIcon } from "lucide-react";
import AppHeader from "../components/AppHeader.jsx";
import NavActions from "../components/NavActions.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Field, FieldLabel } from "../components/ui/field.jsx";
import { Alert, AlertDescription } from "../components/ui/alert.jsx";
import { Spinner } from "../components/ui/spinner.jsx";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "../components/ui/tooltip.jsx";
import { useAuth } from "../lib/auth.jsx";
import { DocumentMeta } from "../lib/seo.jsx";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const { t } = useTranslation("login");
  const { enabled, user, displayName, loading, signInWithMagicLink, signOut } =
    useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!EMAIL_RE.test(email.trim())) {
      setError(t("errors.invalidEmail"));
      return;
    }
    setSending(true);
    try {
      await signInWithMagicLink(email.trim());
      setSent(true);
    } catch (err) {
      setError(err.message || t("errors.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-dvh bg-background">
      <DocumentMeta title={t("meta.title")} />
      <AppHeader
        title={t("meta.title")}
        left={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <RouterLink
                  to="/editor"
                  aria-label={t("nav.editorAriaLabel")}
                  className="mr-0.5 inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10 md:hidden"
                >
                  <PencilIcon />
                </RouterLink>
              </TooltipTrigger>
              <TooltipContent>{t("nav.editor")}</TooltipContent>
            </Tooltip>
            <RouterLink
              to="/editor"
              className="mr-1 hidden shrink-0 items-center gap-2 rounded-md border-0 bg-transparent px-4 py-2 text-sm font-medium text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10 md:inline-flex"
            >
              <PencilIcon data-icon="inline-start" />
              {t("nav.editor")}
            </RouterLink>
          </>
        }
      >
        <NavActions current="login" />
      </AppHeader>

      <div className="mx-auto max-w-sm px-4 pt-12">
        <div className="rounded-panel border border-border bg-card p-8 text-card-foreground shadow-(--shadow-panel)">
          {!enabled ? (
            <Alert>
              <AlertDescription>{t("notConfigured.message")}</AlertDescription>
            </Alert>
          ) : loading ? (
            <div className="flex justify-center py-4">
              <Spinner className="size-8" />
            </div>
          ) : user ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <MailCheckIcon className="size-12 text-primary" />
              <h1 className="text-lg font-semibold">{t("signedIn.heading")}</h1>
              <p className="text-sm break-all text-muted-foreground">
                {displayName || user.email}
              </p>
              <div className="flex gap-2 pt-1">
                <Button onClick={() => navigate("/editor")}>
                  {t("signedIn.goToEditor")}
                </Button>
                <Button variant="outline" onClick={() => signOut()}>
                  {t("signedIn.signOut")}
                </Button>
              </div>
            </div>
          ) : sent ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <MailCheckIcon className="size-12 text-primary" />
              <h1 className="text-lg font-semibold">{t("sent.heading")}</h1>
              <p className="text-sm text-muted-foreground">
                <Trans
                  i18nKey="sent.description"
                  ns="login"
                  values={{ email: email.trim() }}
                  components={{ strong: <strong /> }}
                />
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSent(false);
                  setError("");
                }}
              >
                {t("sent.useDifferentEmail")}
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                {t("form.description")}
              </p>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="login-email">
                  {t("form.emailLabel")}
                </FieldLabel>
                <Input
                  id="login-email"
                  autoFocus
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={sending}
                />
              </Field>
              <Button type="submit" disabled={sending}>
                {sending && <Spinner data-icon="inline-start" />}
                {t("form.submit")}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
