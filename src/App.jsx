// App shell — defines the client-side routes. The editor (the original app)
// lives at "/", the community lesson hub at "/hub", and the magic-link login at
// "/login". Routing and auth wrappers are mounted in main.jsx.

import { Routes, Route, Navigate } from "react-router-dom";
import EditorPage from "./pages/EditorPage.jsx";
import HubPage from "./pages/HubPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<EditorPage />} />
      <Route path="/hub" element={<HubPage />} />
      <Route path="/login" element={<LoginPage />} />
      {/* Unknown paths fall back to the editor. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
