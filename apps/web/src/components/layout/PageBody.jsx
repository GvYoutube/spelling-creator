// The content column every page inside AppShell renders into.
//
// It exists because "the content column" had drifted into five different
// things: max-w-3xl, max-w-5xl and max-w-6xl across the pages, pt-6 or pt-12 at
// the top, pb-16 or pb-24 or nothing at the bottom. None of that variation
// meant anything — it was just whatever each page was written with — and it
// showed as pages that didn't line up with each other as you moved between
// them.
//
// There are two widths, and the difference between them is real:
//
//   wide     — listings, dashboards, and a lesson with its side rail. 64rem,
//              which is also what fits beside the expanded sidebar on a 1280px
//              screen without the page starting to scroll sideways.
//   reading  — prose people actually read or write: comments, a proposal's
//              description, a commit list. 48rem, because a line of text set to
//              the full width of a desktop screen is harder to read, not
//              easier. This is why the page getting wider did NOT make the
//              lesson text wider.
//
// Anything that needs neither (the marketing hero's full-bleed gradient, the
// editor's panes) doesn't use this and says why where it opts out.

import { cn } from "../../lib/utils.js";

/**
 * Exported so the handful of things that need the column's width but can't be
 * the column — the lesson's sticky tab bar, a Suspense fallback — line up with
 * it by reference instead of restating the number and drifting from it.
 */
export const PAGE_WIDTHS = {
  wide: "max-w-5xl",
  reading: "max-w-3xl",
};

/**
 * @param {object} props
 * @param {"wide"|"reading"} [props.width]
 * @param {boolean} [props.flush]  Drop the top padding, for a page whose first
 *   child brings its own (a full-bleed hero, a tab bar).
 */
export default function PageBody({
  width = "wide",
  flush = false,
  className,
  children,
  ...rest
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4",
        PAGE_WIDTHS[width] ?? PAGE_WIDTHS.wide,
        // pb-16 is the same on every page so a page's last element never ends
        // up flush against the bottom of the viewport, and so the editor's
        // floating + button has something to sit over.
        flush ? "pb-16" : "pt-6 pb-16",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
