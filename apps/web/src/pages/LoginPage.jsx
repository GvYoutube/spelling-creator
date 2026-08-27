// Login page. Which ways in it offers is the instance's choice, not this page's
// — see `authMode` in @spelling-creator/core/config.
//
// The hosted instance is magic-link only: the user enters their email, we send a
// one-time link, and Supabase returns them to the app root where the client
// exchanges the callback `?code=` for a session. That is the nicer experience
// and stays the default.
//
// It is also the one that cannot work without a mail server, which a self-hosted
// instance frequently has not got — so an instance can offer a username and
// password instead, or as well. Passwords are username-based rather than
// email-based for the same reason: requiring an address from somebody who will
// never be sent anything is asking for a detail nobody needs. See
// @spelling-creator/core/username for how a username reaches an identity service
// that only understands addresses.
//
// One field takes the identifier, and what it accepts follows the mode: an
// address for a magic link, a new username when registering, and — when the
// instance has mail too — either when signing in, decided by whether the value
// contains an `@` rather than by a toggle somebody has to find.
//
// Already-signed-in users see their account and a way back to the editor; this
// page never blocks the rest of the app, which works fine while signed out
// (only publishing to the hub requires an account).

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { MailCheckIcon } from "lucide-react";
import {
  PASSWORD_MIN_LENGTH,
  usernameDomain,
} from "@spelling-creator/core/config";
import {
  identifierToEmail,
  isUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "@spelling-creator/core/username";
import PageBar from "../components/layout/PageBar.jsx";
import PageBody from "../components/layout/PageBody.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Field, FieldLabel } from "../components/ui/field.jsx";
import { Alert, AlertDescription } from "../components/ui/alert.jsx";
import { Spinner } from "../components/ui/spinner.jsx";
import { useAuth } from "../lib/auth.jsx";
import { DocumentMeta } from "../lib/seo.jsx";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const { t } = useTranslation("login");
  const {
    enabled,
    user,
    displayName,
    loading,
    username,
    passwordAuth,
    magicLinkAuth,
    signInWithMagicLink,
    signInWithPassword,
    signUpWithUsername,
    signOut,
  } = useAuth();
  const navigate = useNavigate();

  // 'password' | 'register' | 'magic-link'. Starts on whichever this instance
  // leads with, and the toggles below only exist when there is a choice.
  const [mode, setMode] = useState(passwordAuth ? "password" : "magic-link");
  // One field for whatever identifies the account: an email address for a magic
  // link, and for a password either a username or an address — decided by the
  // value, not by a toggle the person has to find.
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");

  const registering = mode === "register";

  const switchTo = (next) => {
    setMode(next);
    setError("");
    setPassword("");
    // A username carried into a field now labelled "Email address" reads as a
    // mistake the person made. An address survives the trip in either
    // direction, because both modes accept one.
    if (next === "magic-link" && !EMAIL_RE.test(identifier.trim())) {
      setIdentifier("");
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const value = identifier.trim();

    // A magic link can only go to a real address; registration always creates a
    // username; signing in takes either.
    if (mode === "magic-link" && !EMAIL_RE.test(value)) {
      setError(t("errors.invalidEmail"));
      return;
    }
    if (registering && !isUsername(value)) {
      setError(
        t("errors.invalidUsername", {
          min: USERNAME_MIN_LENGTH,
          max: USERNAME_MAX_LENGTH,
        }),
      );
      return;
    }
    if (mode === "password" && !identifierToEmail(value, usernameDomain())) {
      setError(t("errors.invalidIdentifier"));
      return;
    }
    // Checked here so somebody is told before they submit, not instead of the
    // server's own rule — GoTrue enforces the same minimum.
    if (mode !== "magic-link" && password.length < PASSWORD_MIN_LENGTH) {
      setError(t("errors.passwordTooShort", { count: PASSWORD_MIN_LENGTH }));
      return;
    }
    setBusy(true);
    try {
      if (mode === "magic-link") {
        await signInWithMagicLink(value);
        setSent(true);
      } else if (mode === "password") {
        await signInWithPassword(value, password);
      } else {
        const { needsConfirmation } = await signUpWithUsername(value, password);
        // An instance with mail wants the address confirmed first; one without
        // signs the new account straight in, and the auth listener takes over.
        if (needsConfirmation) setConfirm(true);
      }
    } catch (err) {
      // The identity service knows only about addresses, so a taken username
      // comes back as a taken user. Say what the person actually did.
      const taken = /already registered|already exists|User already/i.test(
        err?.message || "",
      );
      setError(
        registering && taken
          ? t("errors.usernameTaken")
          : err.message || t(`errors.${mode}Failed`),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DocumentMeta title={t("meta.title")} />
      <PageBar crumbs={[{ label: t("meta.title") }]} />

      {/* The card is narrow — a couple of fields — but the column it sits in is
          the app's, not a width of this page's own. */}
      <PageBody width="reading" className="pt-12">
        <div className="mx-auto max-w-sm rounded-panel border border-border bg-card p-8 text-card-foreground shadow-(--shadow-panel)">
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
                {displayName || username || user.email}
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
                  values={{ email: identifier.trim() }}
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
          ) : confirm ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <MailCheckIcon className="size-12 text-primary" />
              <h1 className="text-lg font-semibold">{t("confirm.heading")}</h1>
              <p className="text-sm text-muted-foreground">
                <Trans
                  i18nKey="confirm.description"
                  ns="login"
                  values={{ email: identifier.trim() }}
                  components={{ strong: <strong /> }}
                />
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                {t(
                  mode === "magic-link"
                    ? "form.magicLinkDescription"
                    : registering
                      ? "form.registerDescription"
                      : "form.passwordDescription",
                )}
              </p>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="login-identifier">
                  {t(
                    mode === "magic-link"
                      ? "form.emailLabel"
                      : registering
                        ? "form.usernameLabel"
                        : magicLinkAuth
                          ? "form.identifierLabel"
                          : "form.usernameLabel",
                  )}
                </FieldLabel>
                <Input
                  id="login-identifier"
                  autoFocus
                  // `type=email` would make a browser reject a username as
                  // malformed before this form ever saw it.
                  type={mode === "magic-link" ? "email" : "text"}
                  autoComplete={
                    mode === "magic-link"
                      ? "email"
                      : registering
                        ? "username"
                        : "username"
                  }
                  autoCapitalize="none"
                  spellCheck={false}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  disabled={busy}
                />
              </Field>
              {mode !== "magic-link" && (
                <Field>
                  <FieldLabel htmlFor="login-password">
                    {t("form.passwordLabel")}
                  </FieldLabel>
                  <Input
                    id="login-password"
                    type="password"
                    // Tells a password manager whether to offer a saved password
                    // or to generate one, which is the difference between the
                    // two modes as far as the browser is concerned.
                    autoComplete={
                      registering ? "new-password" : "current-password"
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                  />
                </Field>
              )}
              <Button type="submit" disabled={busy}>
                {busy && <Spinner data-icon="inline-start" />}
                {t(
                  mode === "magic-link"
                    ? "form.submitMagicLink"
                    : registering
                      ? "form.submitRegister"
                      : "form.submitPassword",
                )}
              </Button>

              {/* Only rendered when there is actually a choice to make. */}
              {passwordAuth && (
                <div className="flex flex-col items-center gap-1 pt-1 text-sm">
                  {mode !== "magic-link" && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() =>
                        switchTo(registering ? "password" : "register")
                      }
                    >
                      {t(registering ? "form.haveAccount" : "form.needAccount")}
                    </Button>
                  )}
                  {magicLinkAuth && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() =>
                        switchTo(
                          mode === "magic-link" ? "password" : "magic-link",
                        )
                      }
                    >
                      {t(
                        mode === "magic-link"
                          ? "form.usePassword"
                          : "form.useMagicLink",
                      )}
                    </Button>
                  )}
                </div>
              )}
            </form>
          )}
        </div>
      </PageBody>
    </>
  );
}
