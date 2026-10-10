import { Navigate } from "react-router-dom";

// superchat is a work tool: no landing page, the way in is signing in.
export function WelcomePage() {
  return <Navigate to="/sign-in" replace />;
}
