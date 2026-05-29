// Login page — passwordless magic-link sign-in via Supabase Auth. The user
// enters their email, we send a one-time link, and Supabase returns them to the
// app root where the client exchanges the callback `?code=` for a session.
//
// Already-signed-in users see their account and a way back to the editor; this
// page never blocks the rest of the app, which works fine while signed out
// (only publishing to the hub requires an account).

import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import EditIcon from "@mui/icons-material/Edit";
import MarkEmailReadIcon from "@mui/icons-material/MarkEmailRead";
import NavActions from "../components/NavActions.jsx";
import { useAuth } from "../lib/auth.jsx";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const { enabled, user, loading, signInWithMagicLink, signOut } = useAuth();
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
    <Box sx={{ minHeight: "100vh" }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          <Button
            color="inherit"
            component={RouterLink}
            to="/"
            startIcon={<EditIcon />}
            sx={{ mr: 1 }}
          >
            Editor
          </Button>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Sign in
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <NavActions current="login" />
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="xs" sx={{ pt: 6 }}>
        <Paper elevation={2} sx={{ p: 4 }}>
          {!enabled ? (
            <Alert severity="info">
              Sign-in is not configured. Set VITE_SUPABASE_URL and
              VITE_SUPABASE_ANON_KEY to enable accounts.
            </Alert>
          ) : loading ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress />
            </Box>
          ) : user ? (
            <Stack spacing={2} alignItems="center" textAlign="center">
              <MarkEmailReadIcon color="primary" sx={{ fontSize: 48 }} />
              <Typography variant="h6">You're signed in</Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ wordBreak: "break-all" }}
              >
                {user.email}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ pt: 1 }}>
                <Button variant="contained" onClick={() => navigate("/")}>
                  Go to editor
                </Button>
                <Button onClick={() => signOut()}>Sign out</Button>
              </Stack>
            </Stack>
          ) : sent ? (
            <Stack spacing={2} alignItems="center" textAlign="center">
              <MarkEmailReadIcon color="primary" sx={{ fontSize: 48 }} />
              <Typography variant="h6">Check your email</Typography>
              <Typography variant="body2" color="text.secondary">
                We sent a sign-in link to <strong>{email.trim()}</strong>. Open
                it on this device to finish signing in.
              </Typography>
              <Button
                size="small"
                onClick={() => {
                  setSent(false);
                  setError("");
                }}
              >
                Use a different email
              </Button>
            </Stack>
          ) : (
            <Stack component="form" spacing={2} onSubmit={submit}>
              <Typography variant="body2" color="text.secondary">
                Enter your email and we'll send you a one-time sign-in link — no
                password needed. You only need an account to publish lessons to
                the hub.
              </Typography>
              {error && <Alert severity="error">{error}</Alert>}
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
            </Stack>
          )}
        </Paper>
      </Container>
    </Box>
  );
}
