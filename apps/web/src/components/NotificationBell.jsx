// Notification bell for the AppBar, shown to signed-in users. It polls the
// notification API, shows an unread count as a badge, and opens a menu listing
// notifications (newest first). Opening the menu marks everything read.
//
// Rendered with color="inherit" so it sits naturally inside the coloured AppBar,
// matching NavActions.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import IconButton from "@mui/material/IconButton";
import Badge from "@mui/material/Badge";
import Menu from "@mui/material/Menu";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import ListItemButton from "@mui/material/ListItemButton";
import NotificationsIcon from "@mui/icons-material/Notifications";
import { useAuth } from "../lib/auth.jsx";
import {
  fetchNotifications,
  markNotificationsRead,
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
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle1">Notifications</Typography>
        </Box>
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
    </>
  );
}
