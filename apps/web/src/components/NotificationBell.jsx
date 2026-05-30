// Notification bell for the AppBar, shown to signed-in users. It polls the
// notification API, shows an unread count as a badge, and opens a menu listing
// notifications (newest first). Opening the menu marks everything read. From the
// menu the user can also "send a link" to another user by email, which pops up in
// that user's notifications.
//
// Rendered with color="inherit" so it sits naturally inside the coloured AppBar,
// matching NavActions.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import IconButton from "@mui/material/IconButton";
import Badge from "@mui/material/Badge";
import Menu from "@mui/material/Menu";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import ListItemButton from "@mui/material/ListItemButton";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import DialogContentText from "@mui/material/DialogContentText";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import NotificationsIcon from "@mui/icons-material/Notifications";
import SendIcon from "@mui/icons-material/Send";
import { useAuth } from "../lib/auth.jsx";
import {
  fetchNotifications,
  markNotificationsRead,
  sendLink,
} from "../lib/notifications.js";

// How often to poll for new notifications while the user is signed in.
const POLL_INTERVAL_MS = 30000;

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function NotificationBell() {
  const { enabled, user, accessToken } = useAuth();
  const navigate = useNavigate();

  const [notifications, setNotifications] = useState([]);
  const [anchorEl, setAnchorEl] = useState(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const menuOpen = Boolean(anchorEl);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setNotifications(await fetchNotifications(accessToken));
    } catch {
      // Ignore transient failures; the next poll will retry.
    }
  }, [accessToken]);

  // Poll on mount (and whenever the session changes) and then on an interval.
  useEffect(() => {
    if (!accessToken) {
      setNotifications([]);
      return undefined;
    }
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [accessToken, load]);

  // Only signed-in users have notifications.
  if (!enabled || !user) return null;

  const unread = notifications.filter((n) => !n.read).length;

  const openMenu = async (e) => {
    setAnchorEl(e.currentTarget);
    // Opening the menu marks everything read (optimistically, then on the server).
    if (unread > 0) {
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      try {
        await markNotificationsRead(accessToken);
      } catch {
        // Non-fatal; counts reconcile on the next poll.
      }
    }
  };

  const openNotification = (n) => {
    setAnchorEl(null);
    if (!n.link) return;
    // Internal links route within the app; external ones open in a new tab.
    if (n.link.startsWith("/")) {
      navigate(n.link);
    } else {
      window.open(n.link, "_blank", "noopener");
    }
  };

  return (
    <>
      <Tooltip title="Notifications">
        <IconButton
          color="inherit"
          onClick={openMenu}
          aria-label={`notifications${unread ? ` (${unread} unread)` : ""}`}
        >
          <Badge badgeContent={unread} color="error" max={9}>
            <NotificationsIcon />
          </Badge>
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 340, maxWidth: "90vw" } } }}
      >
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ px: 2, py: 1 }}
        >
          <Typography variant="subtitle1">Notifications</Typography>
          <Button
            size="small"
            startIcon={<SendIcon fontSize="small" />}
            onClick={() => {
              setAnchorEl(null);
              setLinkOpen(true);
            }}
          >
            Send link
          </Button>
        </Stack>
        <Divider />

        {notifications.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ px: 2, py: 2 }}
          >
            No notifications yet.
          </Typography>
        ) : (
          <Box sx={{ maxHeight: 360, overflowY: "auto" }}>
            {notifications.map((n) => (
              <ListItemButton
                key={n.id}
                onClick={() => openNotification(n)}
                disableRipple={!n.link}
                sx={{
                  alignItems: "flex-start",
                  cursor: n.link ? "pointer" : "default",
                  display: "block",
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {n.title}
                </Typography>
                {n.body && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {n.body}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary">
                  {formatDateTime(n.createdAt)}
                </Typography>
              </ListItemButton>
            ))}
          </Box>
        )}
      </Menu>

      <SendLinkDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        accessToken={accessToken}
        onSent={load}
      />
    </>
  );
}

// Dialog for sending a link to another user by email. The link defaults to the
// current page each time the dialog opens. On success it confirms that the link
// will pop up in that user's notifications.
function SendLinkDialog({ open, onClose, accessToken, onSent }) {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  // Reset the form (and default the link to the current page) on each open.
  useEffect(() => {
    if (open) {
      setEmail("");
      setLink(window.location.href);
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
        { email: email.trim(), link: link.trim(), message: message.trim() },
        accessToken,
      );
      setSent(true);
      // Refresh the bell so any self-addressed link shows up immediately.
      onSent?.();
    } catch (err) {
      setError(err.message || "Could not send the link.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Send a link to a user</DialogTitle>
      {sent ? (
        <>
          <DialogContent>
            <Alert severity="success">
              The link was sent. It will pop up in that user&apos;s
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
              Enter the email of the user you want to reach. They&apos;ll see
              the link in their notifications the next time they&apos;re signed
              in.
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
                required
                type="url"
                label="Link"
                placeholder="https://…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
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
              disabled={sending || !email.trim() || !link.trim()}
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
