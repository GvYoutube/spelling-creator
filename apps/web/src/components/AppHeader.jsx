import { Link as RouterLink } from "react-router-dom";

// The sticky top bar shared by every page (title, a back/context link on the
// left, NavActions and page-specific controls on the right). A translucent,
// blurred glass surface — like Dialog/Popover, but tinted with --primary
// instead of --card, so it still reads as "the app chrome" rather than just
// another floating panel. bg-primary/88 (not opaque) is what lets scrolled
// page content blur through underneath as the page is scrolled.
//
// title renders as a RouterLink when titleHref is given, plain text
// otherwise (e.g. ModerationPage's "Moderation" heading isn't a link).
export default function AppHeader({ left, title, titleHref, children }) {
  return (
    // pt-safe keeps the bar's contents clear of the iOS status bar when the app
    // runs installed (standalone), where the page reaches the very top of the
    // screen. It resolves to 0 in a browser tab — see globals.css.
    <header className="sticky top-0 z-40 bg-primary/88 pt-safe text-primary-foreground shadow-[0_1px_3px_rgba(0,0,0,0.15)] backdrop-blur-(--glass-blur) backdrop-saturate-[1.4]">
      {/* The bar's height is a theme token rather than a literal h-16 because
          other things have to pin below it — the editor's sticky section
          headers, and scroll-mt on anything scrolled to programmatically. See
          --header-row-h / --header-h in globals.css. */}
      <div className="mx-auto flex h-(--header-row-h) max-w-6xl items-center gap-1 px-4">
        {left}
        {titleHref ? (
          <RouterLink
            to={titleHref}
            className="min-w-0 flex-1 truncate text-lg font-semibold text-inherit no-underline"
          >
            {title}
          </RouterLink>
        ) : (
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
            {title}
          </h1>
        )}
        <div className="flex shrink-0 items-center gap-1.5">{children}</div>
      </div>
    </header>
  );
}
