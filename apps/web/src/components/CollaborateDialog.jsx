// Collaboration control panel. Drives the WebSocket session exposed by
// useCollaboration (a Cloudflare Durable Object relays it server-side): start
// hosting and share an invite, or join someone else's session by code. The host
// admits ("adds") pending guests to the lesson before they can collaborate,
// matching the admission model in lib/collab.js. Hosting and joining require a
// signed-in account.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  UserPlusIcon,
  XIcon,
  CopyIcon,
  UsersRoundIcon,
  LogInIcon,
  SendIcon,
  Trash2Icon,
  StarIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.jsx";
import { Button } from "./ui/button.jsx";
import { Badge } from "./ui/badge.jsx";
import { Input } from "./ui/input.jsx";
import { Textarea } from "./ui/textarea.jsx";
import { Field, FieldLabel } from "./ui/field.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { Avatar, AvatarImage, AvatarFallback } from "./ui/avatar.jsx";
import { Spinner } from "./ui/spinner.jsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import IconActionButton from "./IconActionButton.jsx";
import { cn } from "../lib/utils.js";
import { colorForId } from "../lib/presence.js";
import { useAuth } from "../lib/auth.jsx";
import { sendLink } from "@spelling-creator/core/notifications";

// Build a shareable invite link that deep-links into the editor with the host's
// session code, so a recipient just clicks and lands on the join screen.
function inviteLink(code) {
  // HashRouter: the app route lives after `#`. Editor is at "/".
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}/?join=${encodeURIComponent(code)}`;
}

function initials(entry) {
  const src = entry.name || entry.email || "?";
  return src.trim().charAt(0).toUpperCase() || "?";
}

// Loose client-side email check — just enough to keep obvious typos out of the
// trusted list. The Worker re-validates on send, so this is only for UX.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// severity -> tone, mapped onto this app's tokens the same way HistoryDialog's
// chip colors are: --success/--destructive already existed; "info" borrows
// --primary, "warning" borrows --focus.
const ALERT_TONES = {
  success: {
    alert: "border-success/40 bg-success/10 text-success",
    text: "text-success",
  },
  info: {
    alert: "border-primary/40 bg-primary/10 text-primary",
    text: "text-primary",
  },
  warning: {
    alert: "border-focus/40 bg-focus/10 text-focus",
    text: "text-focus",
  },
};

function ToneAlert({ severity, icon, children, className }) {
  if (severity === "error") {
    return (
      <Alert variant="destructive" className={className}>
        <AlertDescription>{children}</AlertDescription>
      </Alert>
    );
  }
  const tone = ALERT_TONES[severity];
  return (
    <Alert className={cn(tone.alert, className)}>
      {icon}
      <AlertDescription className={tone.text}>{children}</AlertDescription>
    </Alert>
  );
}

// A single row shared by the pending-requests, roster, and trusted-collaborator
// lists: an avatar, a primary/secondary text pair, and optional trailing content
// (action buttons, a badge).
function PersonRow({
  avatarSrc,
  avatarColor,
  label,
  primary,
  secondary,
  children,
}) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <Avatar className="shrink-0" style={{ backgroundColor: avatarColor }}>
        {avatarSrc && <AvatarImage src={avatarSrc} alt={primary} />}
        <AvatarFallback
          className="text-white"
          style={{ backgroundColor: avatarColor }}
        >
          {label}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{primary}</p>
        {secondary && (
          <p className="truncate text-xs text-muted-foreground">{secondary}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function OrDivider() {
  const { t } = useTranslation("collab");
  return (
    <div className="relative py-1 text-center text-sm text-muted-foreground">
      <hr className="absolute inset-x-0 top-1/2 border-border" />
      <span className="relative bg-card px-2">
        {t("collaborateDialog.orDivider")}
      </span>
    </div>
  );
}

export default function CollaborateDialog({
  open,
  onClose,
  collab,
  initialJoinCode = "",
  trusted = [],
  onTrustedChange,
}) {
  const {
    status,
    role,
    myCode,
    participants,
    requests,
    error,
    startHosting,
    joinSession,
    admit,
    removeParticipant,
    leave,
    clearError,
  } = collab;

  const { t } = useTranslation("collab");
  const { accessToken, user } = useAuth();
  const [joinCode, setJoinCode] = useState(initialJoinCode);
  const [copied, setCopied] = useState(null); // 'code' | 'link' | null
  const [sendOpen, setSendOpen] = useState(false);
  // Status of the automatic invite send to trusted collaborators when a session
  // goes live: { sending, sent: string[], failed: string[] } | null.
  const [autoSend, setAutoSend] = useState(null);

  // When opened from an invite link, prefill the code so the user just confirms.
  useEffect(() => {
    if (open && initialJoinCode) setJoinCode(initialJoinCode);
  }, [open, initialJoinCode]);

  const inSession = status === "hosting" || status === "joined";
  const connecting = status === "connecting";

  // Auto-invite trusted collaborators. Once a host session is live we have a
  // shareable link, so we send it to each trusted collaborator's email — they
  // get the invite in their notifications without the host lifting a finger.
  // We track which (code, email) pairs we've already sent so a re-render or a
  // change to the list never double-sends within the same session; a new
  // session (new myCode) re-sends to everyone, which is what we want.
  const sentRef = useRef(new Set());
  useEffect(() => {
    if (status !== "hosting" || !myCode) {
      sentRef.current = new Set();
      return;
    }
    if (!accessToken) return; // sending notifications needs a signed-in session
    const link = inviteLink(myCode);
    const myEmail = (user?.email || "").trim().toLowerCase();
    const targets = trusted
      .map((entry) => (entry?.email || "").trim().toLowerCase())
      .filter((email) => EMAIL_RE.test(email) && email !== myEmail)
      .filter((email) => !sentRef.current.has(`${myCode}|${email}`));
    if (targets.length === 0) return;

    let cancelled = false;
    (async () => {
      setAutoSend((prev) => ({
        sending: true,
        sent: prev?.sent || [],
        failed: [],
      }));
      const sent = [];
      const failed = [];
      for (const email of targets) {
        sentRef.current.add(`${myCode}|${email}`);
        try {
          await sendLink(
            {
              email,
              link,
              message: t("collaborateDialog.trusted.inviteMessage"),
            },
            accessToken,
          );
          sent.push(email);
        } catch {
          // Let the host retry by re-sending manually; don't block the session.
          sentRef.current.delete(`${myCode}|${email}`);
          failed.push(email);
        }
      }
      if (cancelled) return;
      setAutoSend((prev) => ({
        sending: false,
        sent: [...(prev?.sent || []), ...sent],
        failed,
      }));
    })();

    return () => {
      cancelled = true;
    };
  }, [status, myCode, trusted, accessToken, user, t]);

  // Clear the auto-send banner when a session ends so it doesn't linger.
  useEffect(() => {
    if (status === "idle") setAutoSend(null);
  }, [status]);

  const copy = async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  };

  // ----- Trusted collaborators (per-document list) ------------------------
  const [trustedEmail, setTrustedEmail] = useState("");
  const [trustedError, setTrustedError] = useState("");

  const addTrusted = () => {
    const email = trustedEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      setTrustedError(t("collaborateDialog.trusted.invalidEmail"));
      return;
    }
    if (
      trusted.some(
        (entry) => (entry.email || "").trim().toLowerCase() === email,
      )
    ) {
      setTrustedError(t("collaborateDialog.trusted.alreadyOnList"));
      return;
    }
    onTrustedChange?.([...trusted, { email }]);
    setTrustedEmail("");
    setTrustedError("");
  };

  const removeTrusted = (email) => {
    const key = (email || "").trim().toLowerCase();
    onTrustedChange?.(
      trusted.filter(
        (entry) => (entry.email || "").trim().toLowerCase() !== key,
      ),
    );
  };

  // The pre-session landing: choose to host or to join. Collaboration requires a
  // signed-in account (the WebSocket is authenticated server-side), so when the
  // user isn't signed in we explain that and disable the host/join controls.
  const renderLanding = () => (
    <div className="flex flex-col gap-4 pt-1">
      {!accessToken && (
        <ToneAlert severity="info">
          {t("collaborateDialog.landing.signInPrompt")}
        </ToneAlert>
      )}
      <div>
        <p className="mb-1 text-sm font-medium">
          {t("collaborateDialog.landing.inviteHeading")}
        </p>
        <p className="mb-2 text-sm text-muted-foreground">
          {t("collaborateDialog.landing.inviteDescription")}
        </p>
        <Button onClick={startHosting} disabled={!accessToken}>
          <UsersRoundIcon data-icon="inline-start" />
          {t("collaborateDialog.landing.startSession")}
        </Button>
      </div>

      <OrDivider />

      <div>
        <p className="mb-1 text-sm font-medium">
          {t("collaborateDialog.landing.joinHeading")}
        </p>
        <div className="flex items-start gap-2">
          <Field className="flex-1">
            <FieldLabel htmlFor="join-code" className="sr-only">
              {t("collaborateDialog.landing.joinCodeLabel")}
            </FieldLabel>
            <Input
              id="join-code"
              placeholder={t("collaborateDialog.landing.joinCodePlaceholder")}
              value={joinCode}
              disabled={!accessToken}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") joinSession(joinCode);
              }}
            />
          </Field>
          <Button
            variant="outline"
            onClick={() => joinSession(joinCode)}
            disabled={!accessToken}
            className="shrink-0"
          >
            <LogInIcon data-icon="inline-start" />
            {t("collaborateDialog.landing.join")}
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("collaborateDialog.landing.joinHint")}
        </p>
      </div>

      <hr className="border-border" />

      {renderTrusted()}
    </div>
  );

  const renderConnecting = () => (
    <div className="flex flex-col items-center gap-3 py-8">
      <Spinner className="size-8" />
      <p className="text-sm text-muted-foreground">
        {role === "host"
          ? t("collaborateDialog.connecting.host")
          : t("collaborateDialog.connecting.guest")}
      </p>
    </div>
  );

  const renderHost = () => (
    <div className="flex flex-col gap-4 pt-1">
      <ToneAlert severity="success">
        {t("collaborateDialog.host.sessionLive")}
      </ToneAlert>

      {renderAutoSend()}

      <div>
        <p className="mb-1 text-xs text-muted-foreground">
          {t("collaborateDialog.host.sessionCodeLabel")}
        </p>
        <div className="flex items-center gap-2">
          <Input readOnly value={myCode || ""} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => copy(myCode, "code")}
              >
                <CopyIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {copied === "code"
                ? t("collaborateDialog.host.copiedCode")
                : t("collaborateDialog.host.copyCode")}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copy(inviteLink(myCode), "link")}
          >
            <CopyIcon data-icon="inline-start" />
            {copied === "link"
              ? t("collaborateDialog.host.inviteLinkCopied")
              : t("collaborateDialog.host.copyInviteLink")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSendOpen(true)}>
            <SendIcon data-icon="inline-start" />
            {t("collaborateDialog.host.sendLink")}
          </Button>
        </div>
      </div>

      {requests.length > 0 && (
        <div>
          <p className="mb-1 text-sm font-medium">
            {t("collaborateDialog.host.waitingToJoin", {
              count: requests.length,
            })}
          </p>
          <div className="flex flex-col">
            {requests.map((r) => (
              <PersonRow
                key={r.id}
                avatarSrc={r.avatarUrl}
                avatarColor="var(--focus)"
                label={initials(r)}
                primary={r.name || t("collaborateDialog.host.someone")}
                secondary={
                  r.email || t("collaborateDialog.host.wantsToCollaborate")
                }
              >
                <div className="flex shrink-0 gap-0.5">
                  <IconActionButton
                    tooltip={t("collaborateDialog.host.addToLesson")}
                    onClick={() => admit(r.id)}
                    className="text-primary"
                  >
                    <UserPlusIcon />
                  </IconActionButton>
                  <IconActionButton
                    tooltip={t("collaborateDialog.host.decline")}
                    onClick={() => removeParticipant(r.id)}
                  >
                    <XIcon />
                  </IconActionButton>
                </div>
              </PersonRow>
            ))}
          </div>
        </div>
      )}

      {renderRoster()}

      <hr className="border-border" />

      {renderTrusted({ compact: true })}
    </div>
  );

  const renderGuest = () => {
    // The host only sends its presence roster to guests it has admitted, so a
    // non-empty list is our signal that we've been added to the lesson.
    const admitted = participants.length > 0;
    return (
      <div className="flex flex-col gap-4 pt-1">
        {admitted ? (
          <ToneAlert severity="success">
            You&apos;re collaborating live. Your changes sync with everyone
            here.
          </ToneAlert>
        ) : (
          <ToneAlert severity="info" icon={<Spinner className="size-[18px]" />}>
            Connected — waiting for the host to add you to the lesson.
          </ToneAlert>
        )}
        {admitted && renderRoster()}
      </div>
    );
  };

  const renderRoster = () =>
    participants.length > 0 && (
      <div>
        <p className="mb-1 text-sm font-medium">
          In this lesson ({participants.length})
        </p>
        <div className="flex flex-col">
          {participants.map((p) => (
            <PersonRow
              key={p.id}
              avatarSrc={p.avatarUrl}
              avatarColor={p.host ? "var(--primary)" : colorForId(p.id)}
              label={initials(p)}
              primary={
                p.name || t("collaborateDialog.roster.collaboratorFallback")
              }
              secondary={p.email}
            >
              {p.host ? (
                <Badge
                  variant="outline"
                  className="shrink-0 border-primary/40 text-primary"
                >
                  {t("collaborateDialog.roster.host")}
                </Badge>
              ) : role === "host" ? (
                <IconActionButton
                  tooltip={t("collaborateDialog.roster.removeFromLesson")}
                  onClick={() => removeParticipant(p.id)}
                >
                  <XIcon />
                </IconActionButton>
              ) : null}
            </PersonRow>
          ))}
        </div>
      </div>
    );

  // Manage the per-document trusted-collaborator list and explain the
  // auto-invite behaviour. `compact` drops the explanatory copy for the
  // in-session (host) view where space is tighter.
  const renderTrusted = ({ compact = false } = {}) => (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <StarIcon className="size-4 text-focus" />
        <p className="text-sm font-medium">
          {t("collaborateDialog.trusted.heading")}
        </p>
      </div>
      {!compact && (
        <p className="mb-2 text-sm text-muted-foreground">
          {t("collaborateDialog.trusted.description")}
        </p>
      )}

      <div className="flex items-start gap-2">
        <Field className="flex-1">
          <FieldLabel htmlFor="trusted-email" className="sr-only">
            {t("collaborateDialog.trusted.addByEmailLabel")}
          </FieldLabel>
          <Input
            id="trusted-email"
            type="email"
            placeholder={t("collaborateDialog.emailPlaceholder")}
            value={trustedEmail}
            aria-invalid={Boolean(trustedError)}
            onChange={(e) => {
              setTrustedEmail(e.target.value);
              if (trustedError) setTrustedError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTrusted();
              }
            }}
          />
          {trustedError && (
            <p className="text-xs text-destructive">{trustedError}</p>
          )}
        </Field>
        <Button
          variant="outline"
          onClick={addTrusted}
          disabled={!trustedEmail.trim()}
          className="shrink-0"
        >
          <UserPlusIcon data-icon="inline-start" />
          {t("collaborateDialog.trusted.add")}
        </Button>
      </div>

      {trusted.length > 0 && (
        <div className="mt-2 flex flex-col">
          {trusted.map((entry) => (
            <PersonRow
              key={entry.email}
              avatarColor="var(--focus)"
              label={initials(entry)}
              primary={entry.name || entry.email}
              secondary={entry.name ? entry.email : undefined}
            >
              <IconActionButton
                tooltip={t("collaborateDialog.trusted.remove")}
                onClick={() => removeTrusted(entry.email)}
                destructive
              >
                <Trash2Icon />
              </IconActionButton>
            </PersonRow>
          ))}
        </div>
      )}

      {!accessToken && trusted.length > 0 && (
        <ToneAlert severity="info" className="mt-2">
          Sign in to automatically email the invite link to trusted
          collaborators.
        </ToneAlert>
      )}
    </div>
  );

  // A short banner summarising the automatic invite send to trusted people.
  const renderAutoSend = () =>
    autoSend &&
    (autoSend.sending ||
      autoSend.sent.length > 0 ||
      autoSend.failed.length > 0) && (
      <ToneAlert
        severity={autoSend.failed.length > 0 ? "warning" : "success"}
        icon={
          autoSend.sending ? (
            <Spinner className="size-[18px]" />
          ) : (
            <SendIcon className="size-4" />
          )
        }
      >
        {autoSend.sending
          ? "Sending the invite link to your trusted collaborators…"
          : autoSend.failed.length > 0
            ? `Invited ${autoSend.sent.length}; couldn't reach ${autoSend.failed.join(", ")}.`
            : `Invite link sent to ${autoSend.sent.length} trusted collaborator${
                autoSend.sent.length === 1 ? "" : "s"
              }.`}
      </ToneAlert>
    );

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("collaborateDialog.title")}</DialogTitle>
          </DialogHeader>

          <div className="overflow-y-auto border-t border-border pt-3">
            {error && (
              <Alert variant="destructive" className="relative mb-3 pr-9">
                <AlertDescription>{error}</AlertDescription>
                <button
                  type="button"
                  onClick={clearError}
                  aria-label={t("collaborateDialog.dismiss")}
                  className="absolute top-3 right-3 cursor-pointer rounded-sm border-0 bg-transparent p-0.5 text-current opacity-70 transition-opacity hover:opacity-100"
                >
                  <XIcon className="size-3.5" />
                </button>
              </Alert>
            )}
            {connecting
              ? renderConnecting()
              : status === "hosting"
                ? renderHost()
                : status === "joined"
                  ? renderGuest()
                  : renderLanding()}
          </div>

          <DialogFooter>
            {inSession || connecting ? (
              <Button
                variant="destructive"
                onClick={leave}
                className="sm:mr-auto"
              >
                {role === "host"
                  ? t("collaborateDialog.endSession")
                  : t("collaborateDialog.leave")}
              </Button>
            ) : null}
            <Button variant="outline" onClick={onClose}>
              {t("collaborateDialog.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SendLinkDialog
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        accessToken={accessToken}
        link={myCode ? inviteLink(myCode) : ""}
      />
    </>
  );
}

// Sends the session's generated invite link to another user by email; it pops up
// in that user's notifications. The link itself is fixed to the live session's
// invite link — the sender only chooses the recipient and an optional message.
function SendLinkDialog({ open, onClose, accessToken, link }) {
  const { t } = useTranslation("collab");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  // Reset the form on each open.
  useEffect(() => {
    if (open) {
      setEmail("");
      setMessage("");
      setError("");
      setSent(false);
      setSending(false);
    }
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError("");
    try {
      await sendLink(
        { email: email.trim(), link, message: message.trim() },
        accessToken,
      );
      setSent(true);
    } catch (err) {
      setError(
        err.message || t("collaborateDialog.sendLinkDialog.sendFailedDefault"),
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("collaborateDialog.sendLinkDialog.title")}
          </DialogTitle>
        </DialogHeader>
        {sent ? (
          <>
            <Alert className="border-success/40 bg-success/10 text-success">
              <AlertDescription className="text-success">
                {t("collaborateDialog.sendLinkDialog.sentMessage")}
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={onClose}>
                {t("collaborateDialog.sendLinkDialog.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogDescription>
              {t("collaborateDialog.sendLinkDialog.description")}
            </DialogDescription>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel htmlFor="send-link-email">
                {t("collaborateDialog.sendLinkDialog.recipientEmailLabel")}
              </FieldLabel>
              <Input
                id="send-link-email"
                autoFocus
                required
                type="email"
                placeholder={t("collaborateDialog.emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={sending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="send-link-message">
                {t("collaborateDialog.sendLinkDialog.messageLabel")}
              </FieldLabel>
              <Textarea
                id="send-link-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={sending}
                maxLength={1000}
                className="min-h-16"
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={sending}
              >
                {t("collaborateDialog.sendLinkDialog.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={sending || !email.trim() || !link}
              >
                {sending && <Spinner data-icon="inline-start" />}
                {!sending && <SendIcon data-icon="inline-start" />}
                {sending
                  ? t("collaborateDialog.sendLinkDialog.sending")
                  : t("collaborateDialog.sendLinkDialog.send")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
