import { useEffect, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.jsx";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Field, FieldLabel } from "./ui/field.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { Spinner } from "./ui/spinner.jsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.jsx";
import { cn } from "../lib/utils.js";
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
export default function ImageSearchDialog({
  open,
  replacing = false,
  onInsert,
  onClose,
}) {
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

  const handleProviderChange = (next) => {
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
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {replacing ? "Replace image" : "Search images"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <ToggleGroup
            type="single"
            value={providerId}
            onValueChange={handleProviderChange}
            disabled={busy}
          >
            {PROVIDERS.map((p) => (
              <ToggleGroupItem key={p.id} value={p.id}>
                {p.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <DialogDescription>
            Search free images from{" "}
            <a
              href={provider.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              {provider.sourceName}
            </a>{" "}
            and{" "}
            {replacing
              ? "swap it in for the current one"
              : "add one to this section"}
            .
          </DialogDescription>

          <div className="flex items-start gap-2">
            <Field className="flex-1">
              <FieldLabel htmlFor="image-search-query">
                Search images
              </FieldLabel>
              <Input
                id="image-search-query"
                placeholder="e.g. solar system, tiger, castle"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSearch) handleSearch();
                }}
                disabled={busy}
              />
            </Field>
            <Button
              onClick={handleSearch}
              disabled={!canSearch}
              className="mt-6 h-9 shrink-0"
            >
              {searching ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SearchIcon data-icon="inline-start" />
              )}
              Search
            </Button>
          </div>

          {/* Turnstile widget — only sources that proxy through the Worker need it. */}
          {provider.needsToken && (
            <div ref={widgetRef} className="min-h-[65px]" />
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {hits && hits.length === 0 && !searching && (
            <p className="text-sm text-muted-foreground">
              No images found. Try different words.
            </p>
          )}

          {hits && hits.length > 0 && (
            <div className="grid max-h-[360px] grid-cols-3 gap-2 overflow-y-auto">
              {hits.map((hit) => (
                <div
                  key={hit.id}
                  onClick={() => handlePick(hit)}
                  className={cn(
                    "relative h-[170px] overflow-hidden rounded-md border border-border bg-muted transition-colors",
                    !busy && "cursor-pointer hover:border-primary",
                  )}
                >
                  <img
                    src={hit.previewURL}
                    alt={provider.alt(hit)}
                    loading="lazy"
                    className={cn(
                      "size-full object-contain transition-opacity",
                      insertingId === hit.id ? "opacity-40" : "opacity-100",
                    )}
                  />
                  {insertingId === hit.id && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Spinner className="size-6" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
