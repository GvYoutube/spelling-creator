// Comments on a published lesson, shown beneath the lesson preview in the hub.
// Reading is public; posting needs a signed-in Supabase session (the same one
// that gates publishing). The Worker moderates posts — a comment containing
// profanity is rejected and its reason is surfaced here as an error.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import CircularProgress from "@mui/material/CircularProgress";
import Avatar from "@mui/material/Avatar";
import { useAuth } from "../lib/auth.jsx";
import {
  fetchComments,
  postComment,
  COMMENT_BLOCKED_STATUS,
} from "../lib/comments.js";

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function initial(name) {
  const s = (name || "").trim();
  return s ? s[0].toUpperCase() : "?";
}

export default function CommentsSection({ lessonId }) {
  const navigate = useNavigate();
  const { enabled: authEnabled, user, accessToken } = useAuth();

  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  // A notice shown under the post box after a failed submit. `severity` is
  // "warning" when the comment was blocked for profanity (an expected,
  // user-correctable outcome) and "error" for genuine failures.
  const [postNotice, setPostNotice] = useState(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setComments(await fetchComments(lessonId));
    } catch (err) {
      setError(err.message || "Could not load comments.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (lessonId) load();
    // Reset the in-progress draft state when switching lessons.
    setDraft("");
    setPostNotice(null);
  }, [lessonId]);

  const submit = async (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    setPostNotice(null);
    try {
      const comment = await postComment(lessonId, text, accessToken);
      // Append the new comment to the (oldest-first) list and clear the box.
      setComments((prev) => [...prev, comment]);
      setDraft("");
    } catch (err) {
      // A profanity block is an expected, fixable outcome — show it as a warning
      // (and keep the draft so the user can edit it). Everything else is an error.
      const blocked = err.status === COMMENT_BLOCKED_STATUS;
      setPostNotice({
        severity: blocked ? "warning" : "error",
        message: err.message || "Could not post your comment.",
      });
    } finally {
      setPosting(false);
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Divider sx={{ mb: 2 }} />
      <Typography variant="subtitle1" gutterBottom>
        Comments
        {!loading && !error ? ` (${comments.length})` : ""}
      </Typography>

      {loading && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {!loading && error && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      {!loading && !error && (
        <Stack spacing={2}>
          {comments.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No comments yet. Be the first to share your thoughts.
            </Typography>
          )}

          {comments.map((c) => (
            <Stack key={c.id} direction="row" spacing={1.5} alignItems="flex-start">
              <Avatar sx={{ width: 32, height: 32, fontSize: 14 }}>
                {initial(c.author)}
              </Avatar>
              <Box sx={{ flexGrow: 1 }}>
                <Stack direction="row" spacing={1} alignItems="baseline">
                  <Typography variant="subtitle2">
                    {c.author || "Anonymous"}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatDateTime(c.createdAt)}
                  </Typography>
                </Stack>
                <Typography
                  variant="body2"
                  sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                >
                  {c.body}
                </Typography>
              </Box>
            </Stack>
          ))}

          <Divider />

          {/* Posting needs a signed-in session, mirroring how publishing works. */}
          {!authEnabled ? (
            <Typography variant="body2" color="text.secondary">
              Sign-in is not configured, so commenting is unavailable.
            </Typography>
          ) : user ? (
            <Box component="form" onSubmit={submit}>
              <TextField
                label="Add a comment"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                multiline
                minRows={2}
                fullWidth
                disabled={posting}
                inputProps={{ maxLength: 2000 }}
              />
              {postNotice && (
                <Alert
                  severity={postNotice.severity}
                  sx={{ mt: 1 }}
                  onClose={() => setPostNotice(null)}
                >
                  {postNotice.severity === "warning" && (
                    <AlertTitle>Comment blocked</AlertTitle>
                  )}
                  {postNotice.message}
                </Alert>
              )}
              <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
                <Button
                  type="submit"
                  variant="contained"
                  disabled={posting || !draft.trim()}
                  startIcon={posting ? <CircularProgress size={16} color="inherit" /> : null}
                >
                  {posting ? "Posting…" : "Post comment"}
                </Button>
              </Stack>
            </Box>
          ) : (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              justifyContent="space-between"
            >
              <Typography variant="body2" color="text.secondary">
                Sign in to join the conversation.
              </Typography>
              <Button
                variant="outlined"
                size="small"
                onClick={() => navigate("/login")}
              >
                Sign in
              </Button>
            </Stack>
          )}
        </Stack>
      )}
    </Box>
  );
}
