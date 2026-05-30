// Collaboration control panel. Drives the PeerJS session exposed by
// useCollaboration: start hosting and share an invite, or join someone else's
// session by code. The host admits ("adds") pending guests to the lesson before
// they can collaborate, matching the admission model in lib/collab.js.

import { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
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
import { colorForId } from "../lib/presence.js";

// Build a shareable invite link that deep-links into the editor with the host's
// session code, so a recipient just clicks and lands on the join screen.
function inviteLink(code) {
  // HashRouter: the app route lives after `#`. Editor is at "/".
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/?join=${encodeURIComponent(code)}`;
}

function initials(entry) {
  const src = entry.name || entry.email || "?";
  return src.trim().charAt(0).toUpperCase() || "?";
}

export default function CollaborateDialog({
  open,
  onClose,
  collab,
  initialJoinCode = "",
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

  const [joinCode, setJoinCode] = useState(initialJoinCode);
  const [copied, setCopied] = useState(null); // 'code' | 'link' | null

  // When opened from an invite link, prefill the code so the user just confirms.
  useEffect(() => {
    if (open && initialJoinCode) setJoinCode(initialJoinCode);
  }, [open, initialJoinCode]);

  const inSession = status === "hosting" || status === "joined";
  const connecting = status === "connecting";

  const copy = async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
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
        <Button
          size="small"
          startIcon={<ContentCopyIcon fontSize="small" />}
          onClick={() => copy(inviteLink(myCode), "link")}
          sx={{ mt: 0.5 }}
        >
          {copied === "link" ? "Invite link copied!" : "Copy invite link"}
        </Button>
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

  return (
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
  );
}
