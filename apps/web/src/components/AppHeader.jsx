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
    <header className="sticky top-0 z-40 bg-primary/88 text-primary-foreground shadow-[0_1px_3px_rgba(0,0,0,0.15)] backdrop-blur-(--glass-blur) backdrop-saturate-[1.4]">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-1 px-4">
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
