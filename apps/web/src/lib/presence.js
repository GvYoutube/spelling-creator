// Helpers for live editing presence: a stable per-collaborator colour and the
// pixel position of a caret inside a <textarea>/<input>. These power the
// floating "who's editing where" avatars (see components/CollabCursors.jsx).

// A small, visually distinct palette. Each collaborator is mapped to one colour
// by hashing their stable id, so the same person keeps the same colour across
// their floating cursor and the roster avatar in CollaborateDialog.
const PALETTE = [
  "#e53935", "#8e24aa", "#3949ab", "#039be5",
  "#00897b", "#7cb342", "#fb8c00", "#6d4c41",
  "#d81b60", "#5e35b1", "#1e88e5", "#00acc1",
  "#43a047", "#f4511e", "#546e7a", "#c0ca33",
];

export function colorForId(id) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Properties copied onto the mirror element so it lays text out identically to
// the real field. Based on the well-known textarea-caret-position technique.
const MIRROR_PROPS = [
  "direction", "boxSizing", "width", "height", "overflowX", "overflowY",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize",
  "fontSizeAdjust", "lineHeight", "fontFamily",
  "textAlign", "textTransform", "textIndent", "textDecoration",
  "letterSpacing", "wordSpacing", "tabSize", "MozTabSize",
];

/**
 * Pixel coordinates of the caret at `index` within a textarea/input, relative
 * to the element's own top-left (border box). Add the element's
 * getBoundingClientRect() and subtract its scroll offsets to get a viewport
 * position. Works by mirroring the field in an off-screen div and measuring
 * where a marker span lands.
 *
 * @returns {{ left: number, top: number, height: number }}
 */
export function getCaretCoordinates(element, index) {
  const isInput = element.nodeName.toLowerCase() === "input";
  const computed = window.getComputedStyle(element);

  const div = document.createElement("div");
  const style = div.style;
  style.position = "absolute";
  style.visibility = "hidden";
  style.whiteSpace = "pre-wrap";
  if (!isInput) style.wordWrap = "break-word";

  for (const prop of MIRROR_PROPS) {
    if (isInput && prop === "lineHeight") {
      // Single-line inputs render text vertically centred; approximate that by
      // letting the line fill the element's height.
      style.lineHeight = computed.height;
    } else {
      style[prop] = computed[prop];
    }
  }
  // Inputs never wrap and we don't want the mirror to scroll.
  style.overflow = "hidden";

  div.textContent = element.value.substring(0, index);
  // Spaces in a single-line input must not collapse in the mirror.
  if (isInput) div.textContent = div.textContent.replace(/\s/g, " ");

  const span = document.createElement("span");
  // The remaining text gives the span a sensible height; a fallback keeps it
  // non-empty at the very end of the field.
  span.textContent = element.value.substring(index) || ".";
  div.appendChild(span);

  document.body.appendChild(div);
  const coords = {
    left: span.offsetLeft + parseInt(computed.borderLeftWidth, 10),
    top: span.offsetTop + parseInt(computed.borderTopWidth, 10),
    height: parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10) || 18,
  };
  document.body.removeChild(div);
  return coords;
}
