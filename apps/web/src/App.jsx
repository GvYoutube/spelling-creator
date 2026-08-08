// App shell — defines the client-side routes. The landing page (a marketing
// splash when signed out, a personal dashboard when signed in) lives at "/", the
// editor (the original app) at "/editor", the community lesson hub at "/hub", an
// individual lesson's page at "/hub/:id", a user's public profile at "/users/:id",
// the magic-link login at "/login", and the MCP OAuth consent screen at
// "/oauth/authorize" (reached via a redirect from the Worker's GET /authorize —
// see apps/api/src/routes/oauth.js). Routing and auth wrappers are mounted in
// main.jsx.
//
// Which routes are lazy is a deliberate split, not a blanket policy:
//
//   Eager — "/", "/hub", "/hub/:id" and "/users/:id". The last three are the
//   server-rendered routes (apps/api/src/routes/ssr.js), so their components
//   have to be in the bundle the client hydrates with; deferring them would
//   trade a smaller download for a hydration round-trip on exactly the pages
//   where first paint matters most. "/" is the landing page — the most common
//   entry point, and not worth a chunk request.
//
//   Lazy — "/editor", "/moderation", "/login" and "/oauth/authorize". None are
//   server-rendered and none are reachable without a deliberate click. The
//   editor is the one that actually matters: it is ~6,000 lines and the only
//   owner of Yjs, lib0 and the collaboration client, none of which anyone
//   reading a lesson should be downloading.
//
// Tiptap/ProseMirror stays in the eager graph on purpose — CommentsSection uses
// RichTextInput on the public lesson page, so it is not editor-only.

import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AppHeader from "./components/AppHeader.jsx";
import { SectionsSkeleton } from "./components/Skeletons.jsx";
import HomePage from "./pages/HomePage.jsx";
import HubPage from "./pages/HubPage.jsx";
import LessonPage from "./pages/LessonPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";

const EditorPage = lazy(() => import("./pages/EditorPage.jsx"));
const LoginPage = lazy(() => import("./pages/LoginPage.jsx"));
const ModerationPage = lazy(() => import("./pages/ModerationPage.jsx"));
const OAuthAuthorizePage = lazy(() => import("./pages/OAuthAuthorizePage.jsx"));

// Shown while a lazy route's chunk is in flight. The real pages all open with
// AppHeader over a centered column, so this keeps the chrome in place and
// stands placeholder content in for the body rather than flashing a blank page
// — a skeleton, not a spinner, per the project's UI convention.
function RouteFallback() {
  return (
    <>
      <AppHeader title="" />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <SectionsSkeleton />
      </div>
    </>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/hub" element={<HubPage />} />
        <Route path="/hub/:id" element={<LessonPage />} />
        <Route path="/users/:id" element={<ProfilePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/oauth/authorize" element={<OAuthAuthorizePage />} />
        <Route path="/moderation" element={<ModerationPage />} />
        {/* Unknown paths fall back to the homepage. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
