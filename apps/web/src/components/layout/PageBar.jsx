// The sticky bar at the top of every page inside AppShell. It replaces
// AppHeader, and it is deliberately much less than AppHeader was.
//
// The old bar was the app's --primary surface: a block of indigo carrying the
// page title *and* the whole of the app's navigation. Now that AppSidebar holds
// the navigation, a second heavy surface would just compete with it — two
// things both claiming to be the app's chrome. So this one sits on the page
// background, keeps only the glass blur, and carries three things: the sidebar
// toggle, where you are, and what you can do here.
//
// Height still comes from --header-row-h / --header-h in globals.css, which
// remain the single source of truth — the editor's sticky section headers pin
// to them and anything scrolled to programmatically offsets by them. See
// docs/web-app/navigating-large-lessons.md.

import { Fragment } from "react";
import { Link as RouterLink } from "react-router-dom";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { SidebarTrigger } from "../ui/sidebar.jsx";
import { Separator } from "../ui/separator.jsx";

/**
 * @param {object} props
 * @param {Array<{label: string, to?: string}>} props.crumbs  Trail from the
 *   section down to this page. The last entry is the current page and renders
 *   as text however it's given; earlier ones need a `to` to be links. All but
 *   the last are hidden below `sm`, where there isn't room for a trail.
 * @param {React.ReactNode} [props.children]  Page actions, right-aligned.
 */
export default function PageBar({ crumbs = [], children }) {
  const last = crumbs.length - 1;

  return (
    // pt-safe keeps the contents clear of the iOS status bar when the app runs
    // installed, where the page reaches the very top of the screen. It resolves
    // to 0 in a browser tab — see globals.css.
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 pt-safe backdrop-blur-(--glass-blur) backdrop-saturate-[1.4]">
      <div className="flex h-(--header-row-h) items-center gap-1 px-3 sm:px-4">
        <SidebarTrigger className="shrink-0" />
        <Separator
          orientation="vertical"
          className="mr-1 ml-0.5 data-[orientation=vertical]:h-5"
        />

        <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          {crumbs.map((crumb, i) => (
            <Fragment key={`${crumb.label}-${i}`}>
              {i > 0 && (
                <ChevronRightIcon className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
              )}
              {i === last ? (
                <h1 className="min-w-0 truncate text-base font-semibold">
                  {crumb.label}
                </h1>
              ) : (
                <span className={cn("hidden shrink-0 sm:block", "max-w-48")}>
                  {crumb.to ? (
                    <RouterLink
                      to={crumb.to}
                      className="block truncate text-muted-foreground no-underline hover:text-foreground hover:underline"
                    >
                      {crumb.label}
                    </RouterLink>
                  ) : (
                    <span className="block truncate text-muted-foreground">
                      {crumb.label}
                    </span>
                  )}
                </span>
              )}
            </Fragment>
          ))}
        </nav>

        {children && (
          <div className="flex shrink-0 items-center gap-1.5">{children}</div>
        )}
      </div>
    </header>
  );
}
