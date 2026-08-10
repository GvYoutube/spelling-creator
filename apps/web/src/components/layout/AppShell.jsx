// The chrome every page of the app sits inside: one collapsible sidebar on the
// left, the routed page beside it.
//
// This is a React Router *layout route* (see App.jsx) rather than something each
// page renders for itself, and that is the point of it. Every page used to open
// with `<AppHeader>` over `mx-auto max-w-*`, which is why they all looked alike;
// with the shell hoisted into the route table a page only has to describe its
// own body.
//
// It takes no configuration, deliberately. An earlier version let callers pass
// `defaultOpen`, `persist` and `collapsible`, and the editor passed all three to
// pin itself to a narrow rail — which meant the app had two sidebars of
// different widths that collapsed differently, and one route that quietly threw
// away the state you had set on every other route. Every page now gets the same
// sidebar, at the same width, remembering the same thing. Pages that need more
// room ask the *container* for it (see below) instead of asking the shell to be
// different.
//
// One route stays outside the shell: /oauth/authorize. It is a consent screen
// reached by redirect from a third-party MCP client, and app navigation on it
// would be an invitation to wander off mid-grant.

import { Suspense, useEffect, useLayoutEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { SidebarProvider, SidebarInset } from "../ui/sidebar.jsx";
import { SectionsSkeleton } from "../Skeletons.jsx";
import AppSidebar from "./AppSidebar.jsx";
import PageBody from "./PageBody.jsx";

// ui/sidebar.jsx writes this when the user toggles the sidebar; nothing there
// reads it back, because a render that consulted document.cookie would disagree
// with the Worker's render, which never sees one. Restoring it is therefore this
// component's job, and it happens after the first render rather than during it.
const SIDEBAR_COOKIE_RE = /(?:^|;\s*)sidebar_state=(true|false)/;

// What the server renders and what the client's first render must therefore
// match. A saved preference is applied immediately afterwards.
const DEFAULT_OPEN = true;

// Before paint on the client, a no-op on the Worker. The restore has to land
// before the browser paints — a sidebar that visibly swings shut a frame after
// load is worse than one that doesn't remember at all — but useLayoutEffect
// warns if it runs during a server render, so the server gets the effect that
// never fires there anyway.
const useBeforePaint =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function AppShell() {
  const [open, setOpen] = useState(DEFAULT_OPEN);

  useBeforePaint(() => {
    const saved = document.cookie.match(SIDEBAR_COOKIE_RE);
    if (saved) setOpen(saved[1] === "true");
  }, []);

  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <AppSidebar />
      {/* SidebarInset is the page column.
          - min-w-0, because without it this flex item takes its width from its
            widest child, so one wide table or code block would push the whole
            layout sideways instead of scrolling within itself.
          - @container/page, because the sidebar is 16rem when open and 3rem
            when collapsed, so the page's own width is not a function of the
            viewport's. Anything that wants to lay out against the space it
            actually has — the editor's panes, the lesson's side rail — keys off
            this container rather than a `lg:`/`xl:` viewport breakpoint. That is
            what lets one sidebar configuration work everywhere: collapse it and
            the panes gain the 13rem, immediately. */}
      <SidebarInset className="@container/page min-w-0">
        {/* A Suspense boundary of its own, inside the provider. App.jsx has one
            too, but it sits *above* the layout routes: a lazy page suspending
            there unwinds past this shell, so the sidebar and the page bar
            disappear for as long as the chunk is in flight — and any fallback
            using them would throw, having lost the provider with them. Catching
            it here keeps the chrome on screen and replaces only the body. */}
        <Suspense
          fallback={
            <PageBody>
              <SectionsSkeleton />
            </PageBody>
          }
        >
          <Outlet />
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  );
}
