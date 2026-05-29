import { useEffect, useRef, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import DialogContentText from "@mui/material/DialogContentText";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Alert from "@mui/material/Alert";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import IconButton from "@mui/material/IconButton";
import ImageList from "@mui/material/ImageList";
import ImageListItem from "@mui/material/ImageListItem";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import SearchIcon from "@mui/icons-material/Search";
import { searchPixabayImages, fetchPixabayImage } from "../lib/pixabay.js";
import { TURNSTILE_SITE_KEY, whenTurnstileReady } from "../lib/turnstile.js";

/**
 * Dialog that searches Pixabay for images and inserts the chosen one as an
 * image block. Both the search and the per-image download go through the
 * spelling-creator-cf Worker (so the API key stays server-side and Pixabay's
 * rate limit is enforced there), and each request carries a fresh Turnstile
 * token — exactly like the AI dialogs.
 *
 * Turnstile tokens are single-use, so after every Worker call we reset the
 * widget to mint a new token for the next action (search again, or pick an
 * image to insert).
 */
export default function ImageSearchDialog({ open, onInsert, onClose }) {
  const [query, setQuery] = useState("");
  const [token, setToken] = useState("");
  const [hits, setHits] = useState(null); // null = no search yet; [] = no results
  const [searching, setSearching] = useState(false);
  const [insertingId, setInsertingId] = useState(null);
  const [error, setError] = useState("");
  const widgetRef = useRef(null);

  const busy = searching || insertingId !== null;

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setToken("");
      setHits(null);
      setSearching(false);
      setInsertingId(null);
      setError("");
    }
  }, [open]);

  // Mount the Turnstile widget while the dialog is open; tear it down on close.
  useEffect(() => {
    if (!open) return;
    if (!TURNSTILE_SITE_KEY) {
      setError("VITE_TURNSTILE_SITE_KEY is not configured.");
      return;
    }

    let widgetId;
    let cancelled = false;

    whenTurnstileReady()
      .then((turnstile) => {
        if (cancelled || !widgetRef.current) return;
        widgetId = turnstile.render(widgetRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (t) => setToken(t),
          "expired-callback": () => setToken(""),
          "error-callback": () => {
            setToken("");
            setError("Verification failed. Please try again.");
          },
        });
      })
      .catch((e) => setError(e.message));

    return () => {
      cancelled = true;
      if (widgetId != null && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [open]);

  // A used token can't be reused; mint a fresh one for the next action.
  const refreshToken = () => {
    setToken("");
    if (widgetRef.current && window.turnstile) {
      window.turnstile.reset(widgetRef.current);
    }
  };

  const handleSearch = async () => {
    if (!query.trim()) {
      setError("Type something to search for first.");
      return;
    }
    setSearching(true);
    setError("");
    try {
      const { hits: found } = await searchPixabayImages(query, token);
      setHits(found);
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      // Token is single-use whether the search succeeded or failed.
      refreshToken();
      setSearching(false);
    }
  };

  const handlePick = async (hit) => {
    if (busy) return;
    if (!token) {
      setError("Verification expired — wait a moment and try again.");
      return;
    }
    setInsertingId(hit.id);
    setError("");
    try {
      const dataUrl = await fetchPixabayImage(hit.webformatURL, token);
      onInsert({
        src: dataUrl,
        width: hit.webformatWidth,
        height: hit.webformatHeight,
      });
      onClose();
    } catch (e) {
      setError(e.message || "Could not add that image.");
      refreshToken();
      setInsertingId(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>Search images</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <DialogContentText>
            Search free images from{" "}
            <Link href="https://pixabay.com" target="_blank" rel="noopener">
              Pixabay
            </Link>{" "}
            and add one to this section.
          </DialogContentText>

          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              fullWidth
              size="small"
              label="Search images"
              placeholder="e.g. solar system, tiger, castle"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && token && !busy) handleSearch();
              }}
              disabled={busy}
            />
            <Button
              variant="contained"
              onClick={handleSearch}
              disabled={busy || !token || !query.trim()}
              startIcon={
                searching ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <SearchIcon />
                )
              }
              sx={{ flexShrink: 0, height: 40 }}
            >
              Search
            </Button>
          </Stack>

          <Box ref={widgetRef} sx={{ minHeight: 65 }} />

          {error && <Alert severity="error">{error}</Alert>}

          {hits && hits.length === 0 && !searching && (
            <Typography variant="body2" color="text.secondary">
              No images found. Try different words.
            </Typography>
          )}

          {hits && hits.length > 0 && (
            <ImageList cols={3} gap={8} sx={{ m: 0, maxHeight: 360 }}>
              {hits.map((hit) => (
                <ImageListItem
                  key={hit.id}
                  sx={{
                    cursor: busy ? "default" : "pointer",
                    borderRadius: 1,
                    overflow: "hidden",
                    border: "1px solid",
                    borderColor: "divider",
                    "&:hover": { borderColor: busy ? "divider" : "primary.main" },
                  }}
                >
                  <Box
                    component="img"
                    src={hit.previewURL}
                    alt={hit.tags || "Pixabay image"}
                    loading="lazy"
                    onClick={() => handlePick(hit)}
                    sx={{
                      display: "block",
                      width: "100%",
                      height: 110,
                      objectFit: "cover",
                      opacity: insertingId === hit.id ? 0.4 : 1,
                    }}
                  />
                  {insertingId === hit.id && (
                    <Box
                      sx={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <CircularProgress size={24} />
                    </Box>
                  )}
                </ImageListItem>
              ))}
            </ImageList>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
