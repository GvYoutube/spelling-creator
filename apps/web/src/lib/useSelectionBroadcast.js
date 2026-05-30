// Watches the local user's text selection and reports it upward so it can be
// broadcast to collaborators. We only care about fields tagged with a
// `data-collab-field` attribute (the editor's title/section/block inputs); the
// attribute's value is a stable key identifying that field across all peers.
//
// `onSelect` is called with { field, start, end } while editing such a field,
// and with null when focus leaves it (so collaborators stop showing our
// cursor). Events are coalesced through requestAnimationFrame and de-duped, so
// a flurry of selectionchange events becomes at most one report per frame.

import { useEffect, useRef } from "react";

export function useSelectionBroadcast({ active, onSelect }) {
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!active) return undefined;

    const last = { field: null, start: null, end: null };
    let raf = 0;

    const read = () => {
      raf = 0;
      const el = document.activeElement;
      const field = el && el.getAttribute ? el.getAttribute("data-collab-field") : null;
      const tag = el && el.nodeName ? el.nodeName.toLowerCase() : "";

      if (field && (tag === "textarea" || tag === "input")) {
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? start;
        if (last.field !== field || last.start !== start || last.end !== end) {
          last.field = field;
          last.start = start;
          last.end = end;
          onSelectRef.current?.({ field, start, end });
        }
      } else if (last.field !== null) {
        last.field = null;
        last.start = null;
        last.end = null;
        onSelectRef.current?.(null);
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };

    document.addEventListener("selectionchange", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    // `input` in the capture phase covers typing, which moves the caret without
    // always firing selectionchange.
    document.addEventListener("input", schedule, true);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      document.removeEventListener("input", schedule, true);
      // Tell peers our cursor is gone when collaboration stops or we unmount.
      onSelectRef.current?.(null);
    };
  }, [active]);
}
