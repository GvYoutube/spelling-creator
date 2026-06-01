// Moderation dashboard at /moderation — the cross-cutting console for the
// privilege layer (per-content actions like deleting a comment or shadowbanning
// a lesson live inline on those items; this page handles the lists). Visible to
// moderators and admins; admin-only sections (pending deletion requests and
// moderator management) are hidden for plain moderators and, as defence in depth,
// rejected server-side too.
//
// Authorisation is never decided here: the page reads `isModerator`/`isAdmin`
// from the auth context only to choose what to render, and every action calls a
// Worker endpoint that re-derives the caller's role from the database.

import { useEffect, useState } from "react";
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
import IconButton from "@mui/material/IconButton";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import NavActions from "../components/NavActions.jsx";
import { useAuth } from "../lib/auth.jsx";
import {
  listBans,
  banName,
  unbanName,
  banIp,
  unbanIp,
  listModerators,
  addModerator,
  removeModerator,
  listDeleteRequests,
  resolveDeleteRequest,
  listShadowbannedLessons,
  setShadowban,
} from "../lib/moderation.js";

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// A titled card wrapper shared by every section.
function Section({ title, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
      <Typography variant="h6" gutterBottom>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

// --- Bans (names for all mods; IPs for admins) ---------------------------
function BansSection({ accessToken, isAdmin, onToast }) {
  const [names, setNames] = useState([]);
  const [ips, setIps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [ipDraft, setIpDraft] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const { names: n, ips: i } = await listBans(accessToken);
      setNames(n);
      setIps(i);
    } catch (err) {
      setError(err.message || "Could not load bans.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const addName = async () => {
    const name = nameDraft.trim();
    if (!name) return;
    try {
      await banName(name, accessToken);
      setNameDraft("");
      onToast(`Banned “${name}”.`);
      load();
    } catch (err) {
      onToast(err.message || "Could not ban the name.");
    }
  };

  const liftName = async (nameLower) => {
    try {
      await unbanName(nameLower, accessToken);
      onToast("Name ban lifted.");
      load();
    } catch (err) {
      onToast(err.message || "Could not lift the ban.");
    }
  };

  const addIp = async () => {
    const ip = ipDraft.trim();
    if (!ip) return;
    try {
      await banIp(ip, "", accessToken);
      setIpDraft("");
      onToast(`Banned IP ${ip}.`);
      load();
    } catch (err) {
      onToast(err.message || "Could not ban the IP.");
    }
  };

  const liftIp = async (ip) => {
    try {
      await unbanIp(ip, accessToken);
      onToast("IP ban lifted.");
      load();
    } catch (err) {
      onToast(err.message || "Could not lift the ban.");
    }
  };

  return (
    <Section title="Bans">
      {loading ? (
        <CircularProgress size={20} />
      ) : error ? (
        <Alert severity="error">{error}</Alert>
      ) : (
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Banned names
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
              <TextField
                size="small"
                label="Display name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addName()}
              />
              <Button
                variant="contained"
                onClick={addName}
                disabled={!nameDraft.trim()}
              >
                Ban
              </Button>
            </Stack>
            {names.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No name bans.
              </Typography>
            ) : (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {names.map((n) => (
                  <Chip
                    key={n.name_lower}
                    label={n.display_name || n.name_lower}
                    onDelete={() => liftName(n.name_lower)}
                  />
                ))}
              </Stack>
            )}
          </Box>

          {isAdmin && (
            <>
              <Divider />
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Banned IPs
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
                  <TextField
                    size="small"
                    label="IP address"
                    value={ipDraft}
                    onChange={(e) => setIpDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addIp()}
                  />
                  <Button
                    variant="contained"
                    onClick={addIp}
                    disabled={!ipDraft.trim()}
                  >
                    Ban
                  </Button>
                </Stack>
                {ips.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No IP bans.
                  </Typography>
                ) : (
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {ips.map((i) => (
                      <Chip
                        key={i.ip}
                        label={i.ip}
                        onDelete={() => liftIp(i.ip)}
                      />
                    ))}
                  </Stack>
                )}
              </Box>
            </>
          )}
        </Stack>
      )}
    </Section>
  );
}

// --- Shadowbanned lessons (mod+) -----------------------------------------
function ShadowbannedSection({ accessToken, onToast }) {
  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setLessons(await listShadowbannedLessons(accessToken));
    } catch (err) {
      setError(err.message || "Could not load lessons.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const restore = async (lessonId) => {
    try {
      await setShadowban(lessonId, false, accessToken);
      onToast("Lesson restored.");
      setLessons((prev) => prev.filter((l) => l.id !== lessonId));
    } catch (err) {
      onToast(err.message || "Could not restore the lesson.");
    }
  };

  return (
    <Section title="Shadowbanned lessons">
      {loading ? (
        <CircularProgress size={20} />
      ) : error ? (
        <Alert severity="error">{error}</Alert>
      ) : lessons.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No shadowbanned lessons.
        </Typography>
      ) : (
        <Stack spacing={1} divider={<Divider flexItem />}>
          {lessons.map((l) => (
            <Stack
              key={l.id}
              direction="row"
              spacing={1}
              alignItems="center"
              justifyContent="space-between"
            >
              <Box sx={{ minWidth: 0 }}>
                <Link component={RouterLink} to={`/hub/${l.id}`} noWrap>
                  {l.title || "Untitled Lesson"}
                </Link>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  display="block"
                >
                  {l.author || "Anonymous"}
                </Typography>
              </Box>
              <Button size="small" onClick={() => restore(l.id)}>
                Un-shadowban
              </Button>
            </Stack>
          ))}
        </Stack>
      )}
    </Section>
  );
}

// --- Pending lesson-deletion requests (admin) ----------------------------
function DeleteRequestsSection({ accessToken, onToast }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setRequests(await listDeleteRequests(accessToken));
    } catch (err) {
      setError(err.message || "Could not load requests.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const resolve = async (requestId, approve) => {
    try {
      await resolveDeleteRequest(requestId, approve, accessToken);
      onToast(approve ? "Lesson deleted." : "Request denied.");
      setRequests((prev) => prev.filter((r) => r.id !== requestId));
    } catch (err) {
      onToast(err.message || "Could not resolve the request.");
    }
  };

  return (
    <Section title="Pending deletion requests">
      {loading ? (
        <CircularProgress size={20} />
      ) : error ? (
        <Alert severity="error">{error}</Alert>
      ) : requests.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No pending requests.
        </Typography>
      ) : (
        <Stack spacing={2} divider={<Divider flexItem />}>
          {requests.map((r) => (
            <Box key={r.id}>
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                justifyContent="space-between"
              >
                <Box sx={{ minWidth: 0 }}>
                  <Link component={RouterLink} to={`/hub/${r.lessonId}`} noWrap>
                    {r.lessonTitle || "(deleted lesson)"}
                  </Link>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                  >
                    {r.lessonAuthor || "Anonymous"} · {formatDate(r.createdAt)}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    color="error"
                    variant="contained"
                    startIcon={<DeleteOutlineIcon />}
                    onClick={() => resolve(r.id, true)}
                  >
                    Approve
                  </Button>
                  <Button size="small" onClick={() => resolve(r.id, false)}>
                    Deny
                  </Button>
                </Stack>
              </Stack>
              {r.reason && (
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  “{r.reason}”
                </Typography>
              )}
            </Box>
          ))}
        </Stack>
      )}
    </Section>
  );
}

// --- Moderators (admin) ---------------------------------------------------
function ModeratorsSection({ accessToken, onToast }) {
  const [moderators, setModerators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setModerators(await listModerators(accessToken));
    } catch (err) {
      setError(err.message || "Could not load moderators.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const add = async () => {
    const email = emailDraft.trim();
    if (!email) return;
    setAdding(true);
    try {
      await addModerator(email, accessToken);
      setEmailDraft("");
      onToast(`Added ${email} as a moderator.`);
      load();
    } catch (err) {
      onToast(err.message || "Could not add the moderator.");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (userId) => {
    try {
      await removeModerator(userId, accessToken);
      onToast("Moderator removed.");
      setModerators((prev) => prev.filter((m) => m.userId !== userId));
    } catch (err) {
      onToast(err.message || "Could not remove the moderator.");
    }
  };

  return (
    <Section title="Moderators">
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="User email"
          value={emailDraft}
          onChange={(e) => setEmailDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !adding && add()}
          sx={{ minWidth: 240 }}
        />
        <Button
          variant="contained"
          onClick={add}
          disabled={adding || !emailDraft.trim()}
          startIcon={
            adding ? <CircularProgress size={16} color="inherit" /> : null
          }
        >
          Add moderator
        </Button>
      </Stack>
      {loading ? (
        <CircularProgress size={20} />
      ) : error ? (
        <Alert severity="error">{error}</Alert>
      ) : moderators.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No moderators yet.
        </Typography>
      ) : (
        <Stack spacing={1} divider={<Divider flexItem />}>
          {moderators.map((m) => (
            <Stack
              key={m.userId}
              direction="row"
              spacing={1}
              alignItems="center"
              justifyContent="space-between"
            >
              <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                {m.email || m.userId}
              </Typography>
              <IconButton
                size="small"
                aria-label="remove moderator"
                onClick={() => remove(m.userId)}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      )}
    </Section>
  );
}

export default function ModerationPage() {
  const { loading, user, accessToken, isModerator, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [toast, setToast] = useState("");

  // Once auth has settled, a signed-in non-moderator has no business here.
  // (We wait for `loading` so a moderator isn't bounced before their role loads;
  // the role itself resolves shortly after the token, and the API would 403
  // anyway, so this is just to keep the UI honest.)
  useEffect(() => {
    if (!loading && !user) navigate("/login", { replace: true });
  }, [loading, user, navigate]);

  const showAccessNotice = !loading && user && !isModerator;

  return (
    <Box sx={{ minHeight: "100vh", pb: 8 }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar>
          <Button
            color="inherit"
            component={RouterLink}
            to="/hub"
            startIcon={<ArrowBackIcon />}
            sx={{ mr: 1 }}
          >
            Lesson hub
          </Button>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Moderation
          </Typography>
          <NavActions current="moderation" />
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ pt: 3 }}>
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
            <CircularProgress />
          </Box>
        ) : showAccessNotice ? (
          <Alert
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                component={RouterLink}
                to="/hub"
              >
                Back to hub
              </Button>
            }
          >
            You don’t have moderation access.
          </Alert>
        ) : (
          isModerator && (
            <>
              {isAdmin && (
                <DeleteRequestsSection
                  accessToken={accessToken}
                  onToast={setToast}
                />
              )}
              <ShadowbannedSection
                accessToken={accessToken}
                onToast={setToast}
              />
              <BansSection
                accessToken={accessToken}
                isAdmin={isAdmin}
                onToast={setToast}
              />
              {isAdmin && (
                <ModeratorsSection
                  accessToken={accessToken}
                  onToast={setToast}
                />
              )}
            </>
          )
        )}
      </Container>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast("")}
        message={toast}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Box>
  );
}
