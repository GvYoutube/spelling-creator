// App shell — defines the client-side routes. The landing page (a marketing
// splash when signed out, a personal dashboard when signed in) lives at "/", the
// editor (the original app) at "/editor", the community lesson hub at "/hub", an
// individual lesson's page at "/hub/:id", a user's public profile at "/users/:id",
// the magic-link login at "/login", and the MCP OAuth consent screen at
// "/oauth/authorize" (reached via a redirect from the Worker's GET /authorize —
// see apps/api/src/routes/oauth.js). Routing and auth wrappers are mounted in
// main.jsx.

import { Routes, Route, Navigate } from "react-router-dom";
import HomePage from "./pages/HomePage.jsx";
import EditorPage from "./pages/EditorPage.jsx";
import HubPage from "./pages/HubPage.jsx";
import LessonPage from "./pages/LessonPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import ModerationPage from "./pages/ModerationPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import OAuthAuthorizePage from "./pages/OAuthAuthorizePage.jsx";

export default function App() {
  return (
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
  );
}
