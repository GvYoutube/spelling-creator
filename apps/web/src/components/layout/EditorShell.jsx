// The editor's routes, behind one lazy import.
//
// It mounts no chrome of its own — AppShell is already above it in the route
// table, and the editor gets exactly the same sidebar as every other page. This
// file used to configure that sidebar into a narrow, non-persisting rail
// because three editor panes plus a 16rem sidebar don't fit a 1280px screen;
// that is still true, but it is the *panes'* problem to solve, not the
// sidebar's. They size themselves against the `@container/page` AppShell
// publishes, so collapsing the sidebar hands them its 13rem the moment you do
// it — and the sidebar behaves the same here as everywhere else.
//
// What this file is still for is the chunk boundary. Everything the editor owns
// — Yjs, lib0, the collaboration client, ~6,000 lines of page — has to stay
// behind the dynamic import in App.jsx, and a route table that named EditorPage
// directly would pull all of it into the bundle every homepage visitor
// downloads. See also SSR_UNREACHABLE in vite.config.js, which stubs the same
// modules out of the server build for the same reason.

import { Routes, Route } from "react-router-dom";
import EditorPage from "../../pages/EditorPage.jsx";

export default function EditorShell() {
  return (
    // One route for every path under /editor, deliberately — *not* a route per
    // panel. The editor is a single working surface holding a document, a git
    // repository and possibly a live collaboration session; matching /editor
    // and /editor/history to two different <Route>s would put EditorPage in two
    // different places in the element tree and remount it on the way between
    // them, throwing all three away. The panel is a parameter of the page, so
    // EditorPage reads it from the path rather than the route table.
    //
    // A splat rather than `:panel?` for the same reason, arrived at the hard
    // way: `:panel?` matches /editor and /editor/history but *not*
    // /editor/history/extra, and an unmatched nested <Routes> renders nothing —
    // so a link one segment too long was a blank page. Adding a second
    // <Route path="*"> beside it would fix the blank page and reintroduce the
    // remount, since the two routes are two positions in the tree. One route
    // matches everything and stays one position.
    //
    // An unrecognised segment is not redirected away: EditorPage treats
    // anything it doesn't know as "no panel open", which leaves a stale link
    // showing the editor rather than bouncing someone out of it.
    <Routes>
      <Route path="*" element={<EditorPage />} />
    </Routes>
  );
}
