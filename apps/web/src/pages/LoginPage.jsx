// Login page — passwordless magic-link sign-in via Supabase Auth. The user
// enters their email, we send a one-time link, and Supabase returns them to the
// app root where the client exchanges the callback `?code=` for a session.
//
// Already-signed-in users see their account and a way back to the editor; this
// page never blocks the rest of the app, which works fine while signed out
// (only publishing to the hub requires an account).

import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
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
import { useDocumentMeta } from "../lib/seo.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  useDocumentMeta({ title: "Sign in" });
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
      setError("Please enter a valid email address.");
      return;
    }
    setSending(true);
    try {
      await signInWithMagicLink(email.trim());
      setSent(true);
    } catch (err) {
      setError(err.message || "Could not send the sign-in link.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <AppHeader
        title="Sign in"
        left={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <RouterLink
                  to="/editor"
                  aria-label="editor"
                  className="mr-0.5 inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10 md:hidden"
                >
                  <PencilIcon />
                </RouterLink>
              </TooltipTrigger>
              <TooltipContent>Editor</TooltipContent>
            </Tooltip>
            <RouterLink
              to="/editor"
              className="mr-1 hidden shrink-0 items-center gap-2 rounded-md border-0 bg-transparent px-4 py-2 text-sm font-medium text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10 md:inline-flex"
            >
              <PencilIcon data-icon="inline-start" />
              Editor
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
              <AlertDescription>
                Sign-in is not configured. Set VITE_SUPABASE_URL and
                VITE_SUPABASE_ANON_KEY to enable accounts.
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <div className="flex justify-center py-4">
              <Spinner className="size-8" />
            </div>
          ) : user ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <MailCheckIcon className="size-12 text-primary" />
              <h1 className="text-lg font-semibold">You&apos;re signed in</h1>
              <p className="text-sm break-all text-muted-foreground">
                {displayName || user.email}
              </p>
              <div className="flex gap-2 pt-1">
                <Button onClick={() => navigate("/editor")}>
                  Go to editor
                </Button>
                <Button variant="outline" onClick={() => signOut()}>
                  Sign out
                </Button>
              </div>
            </div>
          ) : sent ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <MailCheckIcon className="size-12 text-primary" />
              <h1 className="text-lg font-semibold">Check your email</h1>
              <p className="text-sm text-muted-foreground">
                We sent a sign-in link to <strong>{email.trim()}</strong>. Open
                it on this device to finish signing in.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSent(false);
                  setError("");
                }}
              >
                Use a different email
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Enter your email and we&apos;ll send you a one-time sign-in link
                — no password needed. You only need an account to publish
                lessons to the hub.
              </p>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="login-email">Email address</FieldLabel>
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
                Send magic link
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
