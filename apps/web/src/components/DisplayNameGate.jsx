// Forces a signed-in user to pick a display name before using the app, so we
// never end up showing their email in place of a name. Renders the app as normal
// and overlays a non-dismissable DisplayNameDialog whenever the current user
// still needs to choose a name (see auth.needsDisplayName). New users hit this
// right after the magic-link sign-in completes.

import { useAuth } from "../lib/auth.jsx";
import DisplayNameDialog from "./DisplayNameDialog.jsx";

export default function DisplayNameGate({ children }) {
  const { needsDisplayName } = useAuth();
  return (
    <>
      {children}
      <DisplayNameDialog open={needsDisplayName} required />
    </>
  );
}
