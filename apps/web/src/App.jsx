// App shell — defines the client-side routes.
//
// Every page of the app renders inside one layout route, `AppShell`, which is
// what makes the chrome identical everywhere: the same sidebar, at the same
// width, collapsing the same way and remembering the same state, on the
// homepage and the editor and everything between. Pages describe only their own
// body, and use PageBody for its column so the columns line up too.
//
// There is exactly one exception, and it is deliberate rather than left over:
//
//   /oauth/authorize  — the MCP consent screen, reached by redirect from a
//                       third-party client (apps/api/src/routes/oauth.js). App
//                       navigation on a grant screen is an invitation to wander
//                       off in the middle of one, so it renders bare.
//
// Which routes are lazy is a deliberate split, not a blanket policy:
//
//   Eager — "/", "/hub", "/users/:id" and "/hub/:id" with all its tabs but
//   History. The lesson, hub and profile routes are server-rendered
//   (apps/api/src/routes/ssr.js), so their components have to be in the bundle
//   the client hydrates with; deferring them would trade a smaller download for
//   a hydration round-trip on exactly the pages where first paint matters most.
//   "/" is the landing page — the most common entry point, and not worth a
//   chunk request.
//
//   Lazy — "/hub/:id/history", "/editor", "/moderation", "/login" and
//   "/oauth/authorize". None is server-rendered and none is reachable without a
//   deliberate click. History is the only reader-facing page that needs
//   isomorphic-git and LightningFS (~200 KB). The editor is the one that really
//   matters: ~6,000 lines and the only owner of Yjs, lib0 and the collaboration
//   client, none of which anyone reading a lesson should be downloading —
//   EditorShell exists to hold that chunk boundary.
//
// Tiptap/ProseMirror stays in the eager graph on purpose — CommentsSection uses
// RichTextInput on the public lesson page, so it is not editor-only.

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AppShell from "./components/layout/AppShell.jsx";
import { SectionsSkeleton } from "./components/Skeletons.jsx";
import HomePage from "./pages/HomePage.jsx";
import HubPage from "./pages/HubPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import LessonLayout from "./pages/lesson/LessonLayout.jsx";
import LessonOverview from "./pages/lesson/LessonOverview.jsx";
import LessonDiscussion from "./pages/lesson/LessonDiscussion.jsx";
import LessonProposals from "./pages/lesson/LessonProposals.jsx";
import LessonProposal from "./pages/lesson/LessonProposal.jsx";
import LessonPractice from "./pages/lesson/LessonPractice.jsx";

const LessonHistory = lazy(() => import("./pages/lesson/LessonHistory.jsx"));
const EditorShell = lazy(() => import("./components/layout/EditorShell.jsx"));
const LoginPage = lazy(() => import("./pages/LoginPage.jsx"));
const ModerationPage = lazy(() => import("./pages/ModerationPage.jsx"));
const OAuthAuthorizePage = lazy(() => import("./pages/OAuthAuthorizePage.jsx"));

// Shown while a lazy route's chunk is in flight. A skeleton, not a spinner, per
// the project's UI convention.
//
// This one renders *no chrome at all*, and that is a correctness requirement
// rather than a style choice. This Suspense boundary sits above the layout
// route, so React unwinds past AppShell to reach it — which means anything here
// renders with no SidebarProvider above it, and PageBar would throw from
// SidebarTrigger's useSidebar(). In practice it is almost never seen: AppShell
// has a boundary of its own, so a lazy page inside the shell keeps the sidebar
// and the page bar on screen and only its body is replaced.
function RouteFallback() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-16">
      <SectionsSkeleton />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/hub" element={<HubPage />} />
          {/* The lesson's tabs. LessonLayout owns the fetch and the repo-style
              header; each child renders one tab's body into its <Outlet/>.
              apps/api/src/routes/ssr.js server-renders all of them. */}
          <Route path="/hub/:id" element={<LessonLayout />}>
            <Route index element={<LessonOverview />} />
            <Route path="practice" element={<LessonPractice />} />
            <Route path="discussion" element={<LessonDiscussion />} />
            <Route path="proposals" element={<LessonProposals />} />
            <Route path="proposals/:prId" element={<LessonProposal />} />
            <Route path="history" element={<LessonHistory />} />
          </Route>
          <Route path="/users/:id" element={<ProfilePage />} />
          <Route path="/moderation" element={<ModerationPage />} />
          <Route path="/login" element={<LoginPage />} />
          {/* Trailing * so EditorShell can own the routes below it. */}
          <Route path="/editor/*" element={<EditorShell />} />
          {/* Unknown paths fall back to the homepage. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>

        {/* Outside the shell — see the note at the top of this file. */}
        <Route path="/oauth/authorize" element={<OAuthAuthorizePage />} />
      </Routes>
    </Suspense>
  );
}
