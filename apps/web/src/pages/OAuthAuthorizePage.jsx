// MCP OAuth consent screen — reached via a redirect from the Worker's
// GET /authorize (see apps/api/src/routes/oauth.js) after an MCP client (e.g.
// claude.ai, Claude Desktop) sends the user's browser here to approve a
// connection. An ordinary page of this app: if the user isn't signed in yet,
// it offers the same magic-link sign-in as /login (routed back here via
// `state`, so the flow resumes exactly where it left off); once signed in, it
// shows what the connecting client is asking for and lets the user approve or
// deny — no token is ever shown or copied by hand.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Divider from "@mui/material/Divider";
import CircularProgress from "@mui/material/CircularProgress";
import Skeleton from "@mui/material/Skeleton";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import MarkEmailReadIcon from "@mui/icons-material/MarkEmailRead";
import { useAuth } from "../lib/auth.jsx";
import { fetchOAuthRequest, approveOAuthRequest } from "../lib/mcpOAuth.js";
import { useDocumentMeta } from "../lib/seo.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function OAuthAuthorizePage() {
  useDocumentMeta({ title: "Connect an app" });
  const [searchParams] = useSearchParams();
  const state = searchParams.get("state") || "";
  const { enabled, loading, user, session, displayName, signInWithMagicLink } =
    useAuth();

  const [reqInfo, setReqInfo] = useState(null);
  const [reqError, setReqError] = useState("");
  const [reqLoading, setReqLoading] = useState(true);

  useEffect(() => {
    let active = true;
    if (!state) {
      setReqError("Missing request. Reconnect from your MCP client.");
      setReqLoading(false);
      return;
    }
    fetchOAuthRequest(state)
      .then((info) => {
        if (active) setReqInfo(info);
      })
      .catch((err) => {
        if (active) setReqError(err.message);
      })
      .finally(() => {
        if (active) setReqLoading(false);
      });
    return () => {
      active = false;
    };
  }, [state]);

  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [signInError, setSignInError] = useState("");

  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState("");

  const sendMagicLink = async (e) => {
    e.preventDefault();
    setSignInError("");
    if (!EMAIL_RE.test(email.trim())) {
      setSignInError("Please enter a valid email address.");
      return;
    }
    setSending(true);
    try {
      // Bring the user back to this exact page (with the same request still
      // pending) once they click the emailed link, instead of the site root.
      const redirectTo = `${window.location.origin}/oauth/authorize?state=${encodeURIComponent(state)}`;
      await signInWithMagicLink(email.trim(), redirectTo);
      setSent(true);
    } catch (err) {
      setSignInError(err.message || "Could not send the sign-in link.");
    } finally {
      setSending(false);
    }
  };

  const approve = async () => {
    setDecideError("");
    setDeciding(true);
    try {
      const redirectTo = await approveOAuthRequest(
        state,
        session.access_token,
        session.refresh_token,
      );
      window.location.href = redirectTo;
    } catch (err) {
      setDecideError(err.message || "Could not complete the connection.");
      setDeciding(false);
    }
  };

  const deny = () => {
    if (!reqInfo) return;
    const url = new URL(reqInfo.redirectUri);
    url.searchParams.set("error", "access_denied");
    if (reqInfo.clientState) url.searchParams.set("state", reqInfo.clientState);
    window.location.href = url.toString();
  };

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", alignItems: "center" }}>
      <Container maxWidth="xs">
        <Paper elevation={2} sx={{ p: 4 }}>
          {!enabled ? (
            <Alert severity="info">
              Sign-in is not configured on this deployment.
            </Alert>
          ) : reqLoading || loading ? (
            <Stack spacing={2}>
              <Skeleton
                variant="text"
                sx={{ fontSize: "1.5rem" }}
                width="70%"
              />
              <Skeleton variant="text" width="90%" />
              <Skeleton variant="text" width="80%" />
              <Skeleton variant="rounded" height={40} />
            </Stack>
          ) : reqError ? (
            <Alert severity="error">{reqError}</Alert>
          ) : !user ? (
            <Stack component="form" spacing={2} onSubmit={sendMagicLink}>
              <Stack alignItems="center" spacing={1} textAlign="center">
                <LockOpenIcon color="primary" sx={{ fontSize: 40 }} />
                <Typography variant="h6">Sign in to connect</Typography>
                <Typography variant="body2" color="text.secondary">
                  <strong>{reqInfo.clientName}</strong> wants to publish and
                  manage spelling lessons on your behalf. Sign in to continue.
                </Typography>
              </Stack>
              {sent ? (
                <Alert
                  icon={<MarkEmailReadIcon fontSize="inherit" />}
                  severity="info"
                >
                  Check your email for a sign-in link — opening it on this
                  device brings you right back here.
                </Alert>
              ) : (
                <>
                  {signInError && <Alert severity="error">{signInError}</Alert>}
                  <TextField
                    autoFocus
                    fullWidth
                    type="email"
                    label="Email address"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={sending}
                  />
                  <Button
                    type="submit"
                    variant="contained"
                    disabled={sending}
                    startIcon={
                      sending ? (
                        <CircularProgress size={16} color="inherit" />
                      ) : undefined
                    }
                  >
                    Send magic link
                  </Button>
                </>
              )}
            </Stack>
          ) : (
            <Stack spacing={2}>
              <Stack alignItems="center" spacing={1} textAlign="center">
                <LockOpenIcon color="primary" sx={{ fontSize: 40 }} />
                <Typography variant="h6">
                  Connect {reqInfo.clientName}
                </Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Signed in as <strong>{displayName || user.email}</strong>. This
                will let <strong>{reqInfo.clientName}</strong> publish, update,
                and delete spelling lessons on your behalf — the same as you can
                do yourself in the editor.
              </Typography>
              <Divider />
              {decideError && <Alert severity="error">{decideError}</Alert>}
              <Stack direction="row" spacing={1} justifyContent="flex-end">
                <Button onClick={deny} disabled={deciding}>
                  Deny
                </Button>
                <Button
                  variant="contained"
                  onClick={approve}
                  disabled={deciding}
                  startIcon={
                    deciding ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : undefined
                  }
                >
                  Approve
                </Button>
              </Stack>
            </Stack>
          )}
        </Paper>
      </Container>
    </Box>
  );
}
