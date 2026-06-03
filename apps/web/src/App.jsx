// App shell — defines the client-side routes. The editor (the original app)
// lives at "/", the community lesson hub at "/hub", an individual lesson's page
// at "/hub/:id", a user's public profile at "/users/:id", and the magic-link
// login at "/login". Routing and auth wrappers are mounted in main.jsx.

import { Routes, Route, Navigate } from "react-router-dom";
import EditorPage from "./pages/EditorPage.jsx";
import HubPage from "./pages/HubPage.jsx";
import LessonPage from "./pages/LessonPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import ModerationPage from "./pages/ModerationPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<EditorPage />} />
      <Route path="/hub" element={<HubPage />} />
      <Route path="/hub/:id" element={<LessonPage />} />
      <Route path="/users/:id" element={<ProfilePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/moderation" element={<ModerationPage />} />
      {/* Unknown paths fall back to the editor. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
