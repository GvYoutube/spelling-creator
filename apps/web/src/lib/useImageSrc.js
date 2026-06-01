import { useEffect, useState } from "react";
import { resolveImageSrc } from "./imageRef.js";

// Resolve an image block to a `<img>` src, managing object-URL lifecycle. The
// URL is re-resolved whenever the underlying image changes (a new hash, or a
// legacy data-url src), and any object URL it created is revoked on unmount or
// when the image changes — so a long editing session doesn't leak blob URLs.
// Returns "" until the (async) resolution completes, so callers can show a
// placeholder.
export function useImageSrc(block) {
  const [src, setSrc] = useState("");
  const key = block?.image?.hash || block?.src || "";

  useEffect(() => {
    let cancelled = false;
    let revoke = () => {};
    resolveImageSrc(block)
      .then((resolved) => {
        if (cancelled) {
          resolved.revoke();
          return;
        }
        revoke = resolved.revoke;
        setSrc(resolved.url);
      })
      .catch(() => {
        if (!cancelled) setSrc("");
      });
    return () => {
      cancelled = true;
      revoke();
    };
    // Re-resolve only when the image identity changes, not on unrelated edits
    // (caption, size, alignment) to the same block.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return src;
}
