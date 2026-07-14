// A dialog that lists a user's followers and the users they follow, in two tabs.
// Opened from the follower/following counts on a profile page. Each row links to
// that user's profile. Lists are public (lib/users.fetchFollowList) and loaded
// lazily per tab on first view; the caches are cleared when the dialog closes so a
// reopen reflects any follows made since. A tab shows skeleton rows while loading,
// an error alert on failure, and a friendly empty state otherwise.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemAvatar from "@mui/material/ListItemAvatar";
import ListItemText from "@mui/material/ListItemText";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Skeleton from "@mui/material/Skeleton";
import { fetchFollowList } from "../lib/users.js";
import { richTextToLine } from "../lib/richText.js";

function initial(name) {
  const s = (name || "").trim();
  return s ? s[0].toUpperCase() : "?";
}

// A few placeholder rows (avatar + name line) while a tab's list loads.
function RowsSkeleton({ count = 5 }) {
  return (
    <List disablePadding>
      {Array.from({ length: count }, (_, i) => (
        <Stack
          key={i}
          direction="row"
          spacing={2}
          alignItems="center"
          sx={{ px: 2, py: 1 }}
        >
          <Skeleton variant="circular" width={40} height={40} />
          <Skeleton variant="text" width={`${60 - i * 6}%`} />
        </Stack>
      ))}
    </List>
  );
}

/**
 * @param {object} props
 * @param {boolean} props.open           Whether the dialog is shown.
 * @param {string}  props.userId         The profile whose connections to list.
 * @param {string}  [props.displayName]  That user's name, for the empty-state copy.
 * @param {"followers"|"following"} [props.initialTab]  Which tab to open on.
 * @param {() => void} [props.onClose]   Dismiss handler.
 */
export default function FollowListDialog({
  open,
  userId,
  displayName = "This user",
  initialTab = "followers",
  onClose,
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState(initialTab);
  // Per-tab load state: { loading, error, users }. null means "not requested yet".
  const [state, setState] = useState({ followers: null, following: null });
  // Which tabs have been kicked off, so switching back and forth doesn't refetch.
  const requested = useRef({});

  // Open on the requested tab; clear caches on close so a reopen is fresh.
  useEffect(() => {
    if (open) {
      setTab(initialTab);
    } else {
      requested.current = {};
      setState({ followers: null, following: null });
    }
  }, [open, initialTab]);

  // Load the active tab's list on first view.
  useEffect(() => {
    if (!open || !userId || requested.current[tab]) return;
    requested.current[tab] = true;
    let active = true;
    setState((s) => ({ ...s, [tab]: { loading: true, error: "", users: [] } }));
    fetchFollowList(userId, tab)
      .then((users) => {
        if (active)
          setState((s) => ({
            ...s,
            [tab]: { loading: false, error: "", users },
          }));
      })
      .catch((err) => {
        if (active)
          setState((s) => ({
            ...s,
            [tab]: {
              loading: false,
              error: err.message || "Could not load these.",
              users: [],
            },
          }));
      });
    return () => {
      active = false;
    };
  }, [open, userId, tab]);

  const openProfile = (id) => {
    if (onClose) onClose();
    navigate(`/users/${id}`);
  };

  const current = state[tab];
  const emptyText =
    tab === "followers"
      ? `${displayName} has no followers yet.`
      : `${displayName} isn’t following anyone yet.`;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ pb: 0 }}>Connections</DialogTitle>
      <Tabs
        value={tab}
        onChange={(_e, v) => setTab(v)}
        variant="fullWidth"
        sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}
      >
        <Tab value="followers" label="Followers" />
        <Tab value="following" label="Following" />
      </Tabs>
      <DialogContent sx={{ p: 0, minHeight: 240 }}>
        {!current || current.loading ? (
          <RowsSkeleton />
        ) : current.error ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">{current.error}</Alert>
          </Box>
        ) : current.users.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ px: 2, py: 3 }}
          >
            {emptyText}
          </Typography>
        ) : (
          <List disablePadding>
            {current.users.map((u) => (
              <ListItemButton key={u.id} onClick={() => openProfile(u.id)}>
                <ListItemAvatar>
                  <Avatar>{initial(u.displayName)}</Avatar>
                </ListItemAvatar>
                {/* Bios are rich-text HTML; this is a one-line subtitle, so show the
                    words and drop the markup. */}
                <ListItemText
                  primary={u.displayName || "Anonymous"}
                  secondary={richTextToLine(u.bio, 80) || undefined}
                  primaryTypographyProps={{ noWrap: true }}
                  secondaryTypographyProps={{ noWrap: true }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
    </Dialog>
  );
}
