import { useEffect } from "react";

// How close to a viewport edge the pointer must be (px) before the page starts
// scrolling, and how fast it scrolls right at the edge (px per 60fps frame).
const EDGE_ZONE = 140;
const MAX_SPEED = 24;

// Ease in, so a pointer that just enters the zone creeps and one pinned to the
// very edge flies: a linear ramp feels twitchy at the top of the zone.
const ramp = (t) => Math.min(Math.max(t, 0), 1) ** 2;

// Scroll the page while an HTML5 drag is in flight and the pointer sits near the
// top or bottom of the viewport.
//
// The browser's own drag auto-scroll only advances on pointer *movement*, which
// is why dragging a block to an off-screen position used to mean jiggling the
// mouse against the edge to coax the page along. This drives the scroll from a
// requestAnimationFrame loop instead, so simply *holding* the pointer near an
// edge scrolls smoothly and continuously. The drag events only supply the latest
// pointer Y — both `dragover` (fires on whatever is under the pointer) and
// `drag` (fires on the source element throughout), captured on the document so
// neither can be missed if something in between stops propagation.
export function useDragAutoScroll(active) {
  useEffect(() => {
    if (!active) return;

    let pointerY = null;
    let frame = 0;
    let lastTime = 0;

    const onDragMove = (e) => {
      // Browsers report (0, 0) for the final `drag` event as the drag ends;
      // taking that as a real position would fling the page to the top.
      if (e.clientX === 0 && e.clientY === 0) return;
      pointerY = e.clientY;
    };

    const step = (time) => {
      frame = requestAnimationFrame(step);
      // Scale by real elapsed time so the scroll speed doesn't depend on the
      // display's refresh rate (capped, so a stalled frame can't teleport).
      const dt = lastTime ? Math.min((time - lastTime) / 16.67, 3) : 1;
      lastTime = time;
      if (pointerY == null) return;

      const height = window.innerHeight;
      let dir = 0;
      if (pointerY < EDGE_ZONE) {
        dir = -ramp((EDGE_ZONE - pointerY) / EDGE_ZONE);
      } else if (pointerY > height - EDGE_ZONE) {
        dir = ramp((pointerY - (height - EDGE_ZONE)) / EDGE_ZONE);
      }
      if (dir) window.scrollBy(0, dir * MAX_SPEED * dt);
    };

    document.addEventListener("dragover", onDragMove, true);
    document.addEventListener("drag", onDragMove, true);
    frame = requestAnimationFrame(step);
    return () => {
      document.removeEventListener("dragover", onDragMove, true);
      document.removeEventListener("drag", onDragMove, true);
      cancelAnimationFrame(frame);
    };
  }, [active]);
}
