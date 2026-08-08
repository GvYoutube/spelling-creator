// Floating editing indicators. For each collaborator whose selection we know,
// we draw a small caret bar plus their profile picture pinned to the spot they
// are editing — the avatar "follows" their selected text. Positions are
// recomputed every animation frame while anyone is editing, so the markers stay
// glued to the text as the page scrolls or the document changes underneath.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Avatar, AvatarImage, AvatarFallback } from "./ui/avatar.jsx";
import { getCaretCoordinates } from "@spelling-creator/core/browser/presence";

// Drop a collaborator's marker if we haven't heard a fresh selection from them
// in this long — guards against a stale cursor lingering after a disconnect.
const STALE_MS = 15000;

function initials(c) {
  const src = c.name || c.email || "?";
  return src.trim().charAt(0).toUpperCase() || "?";
}

// Escape a field key for use in a CSS attribute selector (keys contain ':').
function escapeField(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/["\\\]:.]/g, "\\$&");
}

export default function CollabCursors({ selections }) {
  const { t } = useTranslation("collab");
  // A ticking counter that forces a re-measure each frame while cursors exist.
  const [, setTick] = useState(0);

  const cursors = Object.values(selections || {}).filter((c) => c && c.field);
  const activeCount = cursors.length;

  useEffect(() => {
    if (activeCount === 0) return undefined;
    let raf = requestAnimationFrame(function loop() {
      setTick((t) => (t + 1) % 1000000);
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [activeCount]);

  if (activeCount === 0) return null;

  const now = Date.now();
  const markers = [];
  for (const c of cursors) {
    if (now - (c.ts || 0) > STALE_MS) continue;
    const el = document.querySelector(
      `[data-collab-field="${escapeField(c.field)}"]`,
    );
    if (!el) continue;
    // The field is in the document but isn't being rendered — it's inside a
    // section this user has collapsed, and drawing a caret for it would pin a
    // collaborator's avatar over the folded card.
    //
    // checkVisibility() rather than measuring: a collapsed section is hidden
    // with `hidden="until-found"`, i.e. `content-visibility: hidden`, and its
    // descendants still report a full-size getBoundingClientRect — so the
    // measurements below look perfectly reasonable. `closest("[hidden]")` is
    // the fallback for browsers without checkVisibility.
    if (
      el.checkVisibility
        ? !el.checkVisibility()
        : Boolean(el.closest("[hidden]"))
    ) {
      continue;
    }

    const index = typeof c.end === "number" ? c.end : 0;
    let coords;
    try {
      coords = getCaretCoordinates(el, index);
    } catch {
      continue;
    }
    const rect = el.getBoundingClientRect();
    const topWithin = coords.top - el.scrollTop;
    // Hide the marker when the caret is scrolled out of the field's viewport.
    if (topWithin < -coords.height || topWithin > rect.height) continue;

    markers.push({
      key: c.uid,
      color: c.color || "#1e88e5",
      name: c.name || c.email || t("cursors.collaboratorFallback"),
      avatarUrl: c.avatarUrl || undefined,
      label: initials(c),
      x: rect.left + coords.left - el.scrollLeft,
      y: rect.top + topWithin,
      h: coords.height,
    });
  }

  return (
    <div
      aria-hidden
      className="fixed inset-0 z-[1101] overflow-hidden pointer-events-none"
    >
      {markers.map((m) => (
        <div key={m.key} className="absolute" style={{ left: m.x, top: m.y }}>
          {/* The caret bar sitting in the text. */}
          <div
            className="absolute top-0 left-0 w-0.5 rounded-full"
            style={{ height: m.h, backgroundColor: m.color }}
          />
          {/* The floating profile picture + name, anchored just above the caret. */}
          <div className="absolute -left-0.5 -top-1 flex -translate-y-full items-center gap-1 whitespace-nowrap">
            <Avatar
              size="sm"
              className="border-2 border-white shadow-md"
              style={{ backgroundColor: m.color }}
            >
              <AvatarImage src={m.avatarUrl} alt={m.name} />
              <AvatarFallback
                className="text-xs font-medium text-white"
                style={{ backgroundColor: m.color }}
              >
                {m.label}
              </AvatarFallback>
            </Avatar>
            <div
              className="rounded px-1.5 py-px text-[11px] leading-relaxed font-semibold text-white shadow-sm"
              style={{ backgroundColor: m.color }}
            >
              {m.name}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
