// Floating editing indicators. For each collaborator whose selection we know,
// we draw a small caret bar plus their profile picture pinned to the spot they
// are editing — the avatar "follows" their selected text. Positions are
// recomputed every animation frame while anyone is editing, so the markers stay
// glued to the text as the page scrolls or the document changes underneath.

import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Avatar from "@mui/material/Avatar";
import { getCaretCoordinates } from "../lib/presence.js";

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
      name: c.name || c.email || "Collaborator",
      avatarUrl: c.avatarUrl || undefined,
      label: initials(c),
      x: rect.left + coords.left - el.scrollLeft,
      y: rect.top + topWithin,
      h: coords.height,
    });
  }

  return (
    <Box
      aria-hidden
      sx={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: (t) => t.zIndex.appBar + 1,
      }}
    >
      {markers.map((m) => (
        <Box key={m.key} sx={{ position: "absolute", left: m.x, top: m.y }}>
          {/* The caret bar sitting in the text. */}
          <Box
            sx={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "2px",
              height: m.h,
              bgcolor: m.color,
              borderRadius: "1px",
            }}
          />
          {/* The floating profile picture + name, anchored just above the caret. */}
          <Box
            sx={{
              position: "absolute",
              left: "-2px",
              top: "-4px",
              transform: "translateY(-100%)",
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              whiteSpace: "nowrap",
            }}
          >
            <Avatar
              src={m.avatarUrl}
              sx={{
                width: 24,
                height: 24,
                fontSize: 12,
                bgcolor: m.color,
                color: "#fff",
                border: "2px solid #fff",
                boxShadow: 2,
              }}
            >
              {m.label}
            </Avatar>
            <Box
              sx={{
                px: 0.75,
                py: "1px",
                borderRadius: 1,
                bgcolor: m.color,
                color: "#fff",
                fontSize: 11,
                fontWeight: 600,
                lineHeight: 1.6,
                boxShadow: 1,
              }}
            >
              {m.name}
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
