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
import ImageList from "@mui/material/ImageList";
import ImageListItem from "@mui/material/ImageListItem";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import SearchIcon from "@mui/icons-material/Search";
import { searchPixabayImages, fetchPixabayImage } from "../lib/pixabay.js";
import {
  searchWikimediaImages,
  fetchWikimediaImage,
} from "../lib/wikimedia.js";
import { decodeDataUrl, storeImageBytes } from "../lib/imageRef.js";
import { TURNSTILE_SITE_KEY, whenTurnstileReady } from "../lib/turnstile.js";

// The image sources the dialog can search. Each provider hides where its search,
// download, and attribution come from behind a common interface, so the dialog's
// flow is identical regardless of which one is selected:
//
//   search(query, token)  -> hits[]            (each hit: { id, previewURL, ... })
//   resolve(hit, token)   -> { bytes, mime, width, height }
//   caption(hit)          -> attribution string to pre-fill the caption
//
// `needsToken` distinguishes Pixabay (proxied through the Worker, which enforces
// a Turnstile check) from Wikimedia Commons (queried directly from the browser,
// no key and no token needed — see web/src/lib/wikimedia.js).
const PROVIDERS = [
  {
    id: "pixabay",
    label: "Pixabay",
    sourceName: "Pixabay",
    sourceUrl: "https://pixabay.com",
    needsToken: true,
    async search(query, token) {
      const { hits } = await searchPixabayImages(query, token);
      return hits;
    },
    async resolve(hit, token) {
      const dataUrl = await fetchPixabayImage(hit.webformatURL, token);
      const { bytes, mime } = decodeDataUrl(dataUrl);
      return {
        bytes,
        mime,
        width: hit.webformatWidth,
        height: hit.webformatHeight,
      };
    },
    caption(hit) {
      // Attribution (appreciated by Pixabay).
      return hit.user
        ? `Image by ${hit.user} from Pixabay`
        : "Image from Pixabay";
    },
    alt(hit) {
      return hit.tags || "Pixabay image";
    },
  },
  {
    id: "wikimedia",
    label: "Wikimedia Commons",
    sourceName: "Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org",
    needsToken: false,
    async search(query) {
      const { hits } = await searchWikimediaImages(query);
      return hits;
    },
    async resolve(hit) {
      return fetchWikimediaImage(hit);
    },
    caption(hit) {
      // Each Commons image is licensed individually; the hit carries a ready-made
      // attribution string (author + licence + source).
      return hit.caption;
    },
    alt(hit) {
      return hit.tags || "Wikimedia Commons image";
    },
  },
];

/**
 * Dialog that searches an image source and inserts the chosen one as an image
 * block. Pixabay searches/downloads go through the apps/api Worker (so the API
 * key stays server-side and the rate limit is enforced there), each carrying a
 * fresh Turnstile token — exactly like the AI dialogs. Wikimedia Commons is
 * queried directly from the browser (no key, no token).
 *
 * Turnstile tokens are single-use, so after every Worker call we reset the
 * widget to mint a new token for the next action (search again, or pick an
 * image to insert). The widget is only mounted for sources that need a token.
 */
export default function ImageSearchDialog({ open, onInsert, onClose }) {
  const [providerId, setProviderId] = useState("pixabay");
  const [query, setQuery] = useState("");
  const [token, setToken] = useState("");
  const [hits, setHits] = useState(null); // null = no search yet; [] = no results
  const [searching, setSearching] = useState(false);
  const [insertingId, setInsertingId] = useState(null);
  const [error, setError] = useState("");
  const widgetRef = useRef(null);

  const provider = PROVIDERS.find((p) => p.id === providerId) || PROVIDERS[0];
  const busy = searching || insertingId !== null;

  // Reset the search state each time the dialog opens. The chosen source
  // persists across opens (it lives outside this effect).
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

  // Mount the Turnstile widget while the dialog is open AND the current source
  // needs a token; tear it down on close or when switching to a source that
  // doesn't (e.g. Wikimedia).
  useEffect(() => {
    if (!open || !provider.needsToken) return;
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
  }, [open, provider.needsToken]);

  // A used token can't be reused; mint a fresh one for the next action.
  const refreshToken = () => {
    setToken("");
    if (widgetRef.current && window.turnstile) {
      window.turnstile.reset(widgetRef.current);
    }
  };

  const handleProviderChange = (_e, next) => {
    if (!next || next === providerId || busy) return;
    setProviderId(next);
    setHits(null);
    setError("");
    setToken("");
  };

  const handleSearch = async () => {
    if (!query.trim()) {
      setError("Type something to search for first.");
      return;
    }
    if (provider.needsToken && !token) {
      setError("Please complete the verification challenge first.");
      return;
    }
    setSearching(true);
    setError("");
    try {
      const found = await provider.search(query, token);
      setHits(found);
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      // Pixabay's token is single-use whether the search succeeded or failed.
      if (provider.needsToken) refreshToken();
      setSearching(false);
    }
  };

  const handlePick = async (hit) => {
    if (busy) return;
    if (provider.needsToken && !token) {
      setError("Verification expired — wait a moment and try again.");
      return;
    }
    setInsertingId(hit.id);
    setError("");
    try {
      const { bytes, mime, width, height } = await provider.resolve(hit, token);
      const image = await storeImageBytes(bytes, mime);
      onInsert({ image, width, height, caption: provider.caption(hit) });
      onClose();
    } catch (e) {
      setError(e.message || "Could not add that image.");
      if (provider.needsToken) refreshToken();
      setInsertingId(null);
    }
  };

  const canSearch =
    !busy && !!query.trim() && (!provider.needsToken || !!token);

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
          <ToggleButtonGroup
            value={providerId}
            exclusive
            onChange={handleProviderChange}
            size="small"
            color="primary"
            disabled={busy}
          >
            {PROVIDERS.map((p) => (
              <ToggleButton
                key={p.id}
                value={p.id}
                sx={{ textTransform: "none" }}
              >
                {p.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          <DialogContentText>
            Search free images from{" "}
            <Link href={provider.sourceUrl} target="_blank" rel="noopener">
              {provider.sourceName}
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
                if (e.key === "Enter" && canSearch) handleSearch();
              }}
              disabled={busy}
            />
            <Button
              variant="contained"
              onClick={handleSearch}
              disabled={!canSearch}
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

          {/* Turnstile widget — only sources that proxy through the Worker need it. */}
          {provider.needsToken && (
            <Box ref={widgetRef} sx={{ minHeight: 65 }} />
          )}

          {error && <Alert severity="error">{error}</Alert>}

          {hits && hits.length === 0 && !searching && (
            <Typography variant="body2" color="text.secondary">
              No images found. Try different words.
            </Typography>
          )}

          {hits && hits.length > 0 && (
            <ImageList
              cols={3}
              gap={8}
              rowHeight={170}
              sx={{ m: 0, maxHeight: 360 }}
            >
              {hits.map((hit) => (
                <ImageListItem
                  key={hit.id}
                  sx={{
                    cursor: busy ? "default" : "pointer",
                    borderRadius: 1,
                    overflow: "hidden",
                    border: "1px solid",
                    borderColor: "divider",
                    "&:hover": {
                      borderColor: busy ? "divider" : "primary.main",
                    },
                    // MUI's ImageListItem forces `> img { height:100%; object-fit:cover }`,
                    // which crops the preview. Override with higher specificity (`&&`) so
                    // the whole image shows, letterboxed against a subtle background.
                    "&& > img": {
                      objectFit: "contain",
                      bgcolor: "action.hover",
                    },
                  }}
                >
                  <Box
                    component="img"
                    src={hit.previewURL}
                    alt={provider.alt(hit)}
                    loading="lazy"
                    onClick={() => handlePick(hit)}
                    sx={{
                      display: "block",
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
