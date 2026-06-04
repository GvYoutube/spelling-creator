// Floating live-chat panel for a collaboration session, pinned to the bottom
// left of the screen. It's a thin view over the transcript exposed by
// useCollaboration: the messages, who we are (to align our own bubbles), and
// sendChat. The panel only appears once we're actually collaborating — for the
// host that's a live session; for a guest that's after the host has admitted
// them (signalled by a non-empty participant roster).
//
// The transcript itself is ephemeral and lives in the collab hook; here we only
// keep view state: whether the panel is open, the in-progress draft, the
// scroll-to-newest anchor, and an unread count for while it's collapsed.

import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Avatar from "@mui/material/Avatar";
import IconButton from "@mui/material/IconButton";
import Badge from "@mui/material/Badge";
import Tooltip from "@mui/material/Tooltip";
import Fab from "@mui/material/Fab";
import ChatIcon from "@mui/icons-material/Chat";
import CloseIcon from "@mui/icons-material/Close";
import SendIcon from "@mui/icons-material/Send";
import { colorForId } from "../lib/presence.js";

function initials(entry) {
  const src = entry.name || entry.email || "?";
  return src.trim().charAt(0).toUpperCase() || "?";
}

// Short clock label (e.g. "14:05") for a message timestamp.
function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function CollabChat({ collab }) {
  const { status, role, participants, messages, myId, sendChat } = collab;

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // How many messages we'd already shown when the panel was last open, so we can
  // badge the launcher with the number that have arrived since it was collapsed.
  const [seenCount, setSeenCount] = useState(0);
  const endRef = useRef(null);

  // We're in the chat-eligible state when collaborating: hosting a live session,
  // or a guest the host has added (a non-empty roster is our "admitted" signal).
  const admitted = role === "guest" && participants.length > 0;
  const eligible = status === "hosting" || (status === "joined" && admitted);

  // Keep the list scrolled to the newest message whenever it changes while open.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, open]);

  // While open, everything is considered read. (Also runs as new messages land.)
  useEffect(() => {
    if (open) setSeenCount(messages.length);
  }, [open, messages.length]);

  // When the session ends, fold the panel and reset its view state so a fresh
  // session starts clean.
  useEffect(() => {
    if (!eligible) {
      setOpen(false);
      setDraft("");
      setSeenCount(0);
    }
  }, [eligible]);

  if (!eligible) return null;

  const unread = Math.max(0, messages.length - seenCount);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    sendChat(text);
    setDraft("");
  };

  // Collapsed: a small launcher FAB with an unread badge.
  if (!open) {
    return (
      <Box
        sx={{
          position: "fixed",
          left: 16,
          bottom: 16,
          zIndex: (t) => t.zIndex.appBar + 1,
        }}
      >
        <Badge color="error" badgeContent={unread} overlap="circular" max={99}>
          <Tooltip title="Open chat" placement="right">
            <Fab color="primary" size="medium" onClick={() => setOpen(true)}>
              <ChatIcon />
            </Fab>
          </Tooltip>
        </Badge>
      </Box>
    );
  }

  return (
    <Paper
      elevation={6}
      sx={{
        position: "fixed",
        left: 16,
        bottom: 16,
        width: { xs: "calc(100vw - 32px)", sm: 320 },
        maxWidth: 360,
        height: 420,
        maxHeight: "calc(100vh - 32px)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: 2,
        zIndex: (t) => t.zIndex.appBar + 1,
      }}
    >
      {/* Header */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          px: 1.5,
          py: 1,
          bgcolor: "primary.main",
          color: "primary.contrastText",
        }}
      >
        <ChatIcon fontSize="small" />
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Chat
        </Typography>
        <Tooltip title="Close chat">
          <IconButton
            size="small"
            onClick={() => setOpen(false)}
            sx={{ color: "inherit" }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Transcript */}
      <Box
        sx={{ flexGrow: 1, overflowY: "auto", p: 1.5, bgcolor: "action.hover" }}
      >
        {messages.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: "center", py: 3 }}
          >
            No messages yet — say hello!
          </Typography>
        ) : (
          <Stack spacing={1}>
            {messages.map((m) => {
              const mine = m.uid === myId;
              return (
                <Stack
                  key={m.id}
                  direction="row"
                  spacing={1}
                  sx={{ flexDirection: mine ? "row-reverse" : "row" }}
                >
                  <Avatar
                    src={m.avatarUrl || undefined}
                    sx={{
                      width: 28,
                      height: 28,
                      fontSize: 14,
                      bgcolor: mine ? "primary.main" : colorForId(m.uid),
                    }}
                  >
                    {initials(m)}
                  </Avatar>
                  <Box sx={{ minWidth: 0, maxWidth: "75%" }}>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: "block",
                        textAlign: mine ? "right" : "left",
                      }}
                    >
                      {mine ? "You" : m.name || "Collaborator"} ·{" "}
                      {formatTime(m.ts)}
                    </Typography>
                    <Box
                      sx={{
                        px: 1.25,
                        py: 0.75,
                        borderRadius: 1.5,
                        bgcolor: mine ? "primary.main" : "background.paper",
                        color: mine ? "primary.contrastText" : "text.primary",
                        border: mine ? 0 : 1,
                        borderColor: "divider",
                        wordBreak: "break-word",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      <Typography variant="body2">{m.text}</Typography>
                    </Box>
                  </Box>
                </Stack>
              );
            })}
            <div ref={endRef} />
          </Stack>
        )}
      </Box>

      {/* Composer */}
      <Stack
        direction="row"
        spacing={1}
        alignItems="flex-start"
        sx={{ p: 1, borderTop: 1, borderColor: "divider" }}
      >
        <TextField
          size="small"
          fullWidth
          autoFocus
          placeholder="Type a message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          inputProps={{ maxLength: 2000 }}
        />
        <Tooltip title="Send">
          <span>
            <IconButton
              color="primary"
              onClick={submit}
              disabled={!draft.trim()}
              sx={{ mt: 0.25 }}
            >
              <SendIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Paper>
  );
}
