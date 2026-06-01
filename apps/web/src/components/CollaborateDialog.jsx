// Collaboration control panel. Drives the PeerJS session exposed by
// useCollaboration: start hosting and share an invite, or join someone else's
// session by code. The host admits ("adds") pending guests to the lesson before
// they can collaborate, matching the admission model in lib/collab.js.

import { useEffect, useRef, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import ListItemAvatar from "@mui/material/ListItemAvatar";
import Avatar from "@mui/material/Avatar";
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import GroupAddIcon from "@mui/icons-material/GroupAdd";
import LoginIcon from "@mui/icons-material/Login";
import SendIcon from "@mui/icons-material/Send";
import DeleteIcon from "@mui/icons-material/Delete";
import StarIcon from "@mui/icons-material/Star";
import { colorForId } from "../lib/presence.js";
import { useAuth } from "../lib/auth.jsx";
import { sendLink } from "../lib/notifications.js";

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
      .map((t) => (t?.email || "").trim().toLowerCase())
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
              message:
                "You're a trusted collaborator on this lesson — join the live session with this link.",
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
  }, [status, myCode, trusted, accessToken, user]);

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
      setTrustedError("Enter a valid email address.");
      return;
    }
    if (trusted.some((t) => (t.email || "").trim().toLowerCase() === email)) {
      setTrustedError("That collaborator is already on the list.");
      return;
    }
    onTrustedChange?.([...trusted, { email }]);
    setTrustedEmail("");
    setTrustedError("");
  };

  const removeTrusted = (email) => {
    const key = (email || "").trim().toLowerCase();
    onTrustedChange?.(
      trusted.filter((t) => (t.email || "").trim().toLowerCase() !== key),
    );
  };

  // The pre-session landing: choose to host or to join.
  const renderLanding = () => (
    <Stack spacing={3} sx={{ pt: 1 }}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Invite people to this lesson
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Start a live session, then share the code. People who join wait until
          you add them to the lesson — after that, your edits sync both ways in
          real time.
        </Typography>
        <Button
          variant="contained"
          startIcon={<GroupAddIcon />}
          onClick={startHosting}
        >
          Start a collaboration session
        </Button>
      </Box>

      <Divider>or</Divider>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Join someone&apos;s lesson
        </Typography>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <TextField
            size="small"
            fullWidth
            label="Session code"
            placeholder="Paste the code you were given"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") joinSession(joinCode);
            }}
          />
          <Button
            variant="outlined"
            startIcon={<LoginIcon />}
            onClick={() => joinSession(joinCode)}
            sx={{ flexShrink: 0, mt: 0.25 }}
          >
            Join
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Joining replaces your current draft with the host&apos;s lesson.
        </Typography>
      </Box>

      <Divider />

      {renderTrusted()}
    </Stack>
  );

  const renderConnecting = () => (
    <Stack alignItems="center" spacing={2} sx={{ py: 4 }}>
      <CircularProgress />
      <Typography variant="body2" color="text.secondary">
        {role === "host" ? "Starting session…" : "Connecting to the host…"}
      </Typography>
    </Stack>
  );

  const renderHost = () => (
    <Stack spacing={2.5} sx={{ pt: 1 }}>
      <Alert severity="success" variant="outlined">
        Your session is live. Share the code or link below to invite people.
      </Alert>

      {renderAutoSend()}

      <Box>
        <Typography variant="caption" color="text.secondary">
          Session code
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            fullWidth
            value={myCode || ""}
            slotProps={{ input: { readOnly: true } }}
          />
          <Tooltip title={copied === "code" ? "Copied!" : "Copy code"}>
            <IconButton onClick={() => copy(myCode, "code")}>
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 0.5 }}>
          <Button
            size="small"
            startIcon={<ContentCopyIcon fontSize="small" />}
            onClick={() => copy(inviteLink(myCode), "link")}
          >
            {copied === "link" ? "Invite link copied!" : "Copy invite link"}
          </Button>
          <Button
            size="small"
            startIcon={<SendIcon fontSize="small" />}
            onClick={() => setSendOpen(true)}
          >
            Send link
          </Button>
        </Stack>
      </Box>

      {requests.length > 0 && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Waiting to join ({requests.length})
          </Typography>
          <List dense disablePadding>
            {requests.map((r) => (
              <ListItem
                key={r.id}
                secondaryAction={
                  <Stack direction="row" spacing={0.5}>
                    <Tooltip title="Add to lesson">
                      <IconButton
                        edge="end"
                        color="primary"
                        onClick={() => admit(r.id)}
                      >
                        <PersonAddIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Decline">
                      <IconButton
                        edge="end"
                        onClick={() => removeParticipant(r.id)}
                      >
                        <CloseIcon />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                }
              >
                <ListItemAvatar>
                  <Avatar
                    src={r.avatarUrl || undefined}
                    sx={{ bgcolor: "warning.light" }}
                  >
                    {initials(r)}
                  </Avatar>
                </ListItemAvatar>
                <ListItemText
                  primary={r.name || "Someone"}
                  secondary={r.email || "wants to collaborate"}
                />
              </ListItem>
            ))}
          </List>
        </Box>
      )}

      {renderRoster()}

      <Divider />

      {renderTrusted({ compact: true })}
    </Stack>
  );

  const renderGuest = () => {
    // The host only sends its presence roster to guests it has admitted, so a
    // non-empty list is our signal that we've been added to the lesson.
    const admitted = participants.length > 0;
    return (
      <Stack spacing={2.5} sx={{ pt: 1 }}>
        {admitted ? (
          <Alert severity="success" variant="outlined">
            You&apos;re collaborating live. Your changes sync with everyone
            here.
          </Alert>
        ) : (
          <Alert
            severity="info"
            variant="outlined"
            icon={<CircularProgress size={18} />}
          >
            Connected — waiting for the host to add you to the lesson.
          </Alert>
        )}
        {admitted && renderRoster()}
      </Stack>
    );
  };

  const renderRoster = () =>
    participants.length > 0 && (
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          In this lesson ({participants.length})
        </Typography>
        <List dense disablePadding>
          {participants.map((p) => (
            <ListItem
              key={p.id}
              secondaryAction={
                role === "host" && !p.host ? (
                  <Tooltip title="Remove from lesson">
                    <IconButton
                      edge="end"
                      onClick={() => removeParticipant(p.id)}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : null
              }
            >
              <ListItemAvatar>
                <Avatar
                  src={p.avatarUrl || undefined}
                  sx={{ bgcolor: p.host ? "primary.main" : colorForId(p.id) }}
                >
                  {initials(p)}
                </Avatar>
              </ListItemAvatar>
              <ListItemText
                primary={p.name || "Collaborator"}
                secondary={p.email || undefined}
              />
              {p.host && (
                <Chip
                  size="small"
                  label="Host"
                  color="primary"
                  variant="outlined"
                />
              )}
            </ListItem>
          ))}
        </List>
      </Box>
    );

  // Manage the per-document trusted-collaborator list and explain the
  // auto-invite behaviour. `compact` drops the explanatory copy for the
  // in-session (host) view where space is tighter.
  const renderTrusted = ({ compact = false } = {}) => (
    <Box>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.5 }}>
        <StarIcon fontSize="small" color="warning" />
        <Typography variant="subtitle2">Trusted collaborators</Typography>
      </Stack>
      {!compact && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          People on this list are emailed this lesson&apos;s invite link
          automatically whenever you start a session, and they join straight
          away without waiting for your approval. This list is saved with the
          lesson.
        </Typography>
      )}

      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          size="small"
          fullWidth
          type="email"
          label="Add by email"
          placeholder="name@example.com"
          value={trustedEmail}
          error={Boolean(trustedError)}
          helperText={trustedError || undefined}
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
        <Button
          variant="outlined"
          startIcon={<PersonAddIcon />}
          onClick={addTrusted}
          disabled={!trustedEmail.trim()}
          sx={{ flexShrink: 0, mt: 0.25 }}
        >
          Add
        </Button>
      </Stack>

      {trusted.length > 0 && (
        <List dense disablePadding sx={{ mt: 1 }}>
          {trusted.map((t) => (
            <ListItem
              key={t.email}
              secondaryAction={
                <Tooltip title="Remove">
                  <IconButton edge="end" onClick={() => removeTrusted(t.email)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              }
            >
              <ListItemAvatar>
                <Avatar sx={{ bgcolor: "warning.light" }}>{initials(t)}</Avatar>
              </ListItemAvatar>
              <ListItemText
                primary={t.name || t.email}
                secondary={t.name ? t.email : undefined}
              />
            </ListItem>
          ))}
        </List>
      )}

      {!accessToken && trusted.length > 0 && (
        <Alert severity="info" variant="outlined" sx={{ mt: 1 }}>
          Sign in to automatically email the invite link to trusted
          collaborators.
        </Alert>
      )}
    </Box>
  );

  // A short banner summarising the automatic invite send to trusted people.
  const renderAutoSend = () =>
    autoSend &&
    (autoSend.sending ||
      autoSend.sent.length > 0 ||
      autoSend.failed.length > 0) && (
      <Alert
        severity={autoSend.failed.length > 0 ? "warning" : "success"}
        variant="outlined"
        icon={autoSend.sending ? <CircularProgress size={18} /> : <SendIcon />}
      >
        {autoSend.sending
          ? "Sending the invite link to your trusted collaborators…"
          : autoSend.failed.length > 0
            ? `Invited ${autoSend.sent.length}; couldn't reach ${autoSend.failed.join(", ")}.`
            : `Invite link sent to ${autoSend.sent.length} trusted collaborator${
                autoSend.sent.length === 1 ? "" : "s"
              }.`}
      </Alert>
    );

  return (
    <>
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
        <DialogTitle>Collaborate on this lesson</DialogTitle>
        <DialogContent dividers>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={clearError}>
              {error}
            </Alert>
          )}
          {connecting
            ? renderConnecting()
            : status === "hosting"
              ? renderHost()
              : status === "joined"
                ? renderGuest()
                : renderLanding()}
        </DialogContent>
        <DialogActions>
          {inSession || connecting ? (
            <Button color="error" onClick={leave}>
              {role === "host" ? "End session" : "Leave"}
            </Button>
          ) : null}
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
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
      setError(err.message || "Could not send the link.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Send the invite link</DialogTitle>
      {sent ? (
        <>
          <DialogContent>
            <Alert severity="success">
              The invite link was sent. It will pop up in that user&apos;s
              notifications.
            </Alert>
          </DialogContent>
          <DialogActions>
            <Button variant="contained" onClick={onClose}>
              Done
            </Button>
          </DialogActions>
        </>
      ) : (
        <Box component="form" onSubmit={submit}>
          <DialogContent>
            <DialogContentText sx={{ mb: 2 }}>
              Enter the email of the person you want to invite. They&apos;ll see
              this session&apos;s invite link in their notifications the next
              time they&apos;re signed in.
            </DialogContentText>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}
            <Stack spacing={2}>
              <TextField
                autoFocus
                fullWidth
                required
                type="email"
                label="Recipient email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={sending}
              />
              <TextField
                fullWidth
                multiline
                minRows={2}
                label="Message (optional)"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={sending}
                inputProps={{ maxLength: 1000 }}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} disabled={sending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={sending || !email.trim() || !link}
              startIcon={
                sending ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <SendIcon />
                )
              }
            >
              {sending ? "Sending…" : "Send link"}
            </Button>
          </DialogActions>
        </Box>
      )}
    </Dialog>
  );
}
