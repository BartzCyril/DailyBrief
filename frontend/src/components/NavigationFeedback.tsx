import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { notify } from "./Toaster";

/** Show a redirect's success once, including after React's StrictMode effect replay. */
export function NavigationFeedback() {
  const location = useLocation();
  const navigate = useNavigate();
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    const state: unknown = location.state;
    if (
      !state ||
      typeof state !== "object" ||
      !("message" in state) ||
      typeof state.message !== "string"
    )
      return;
    if (shown.current !== location.key) {
      shown.current = location.key;
      notify(state.message);
    }
    navigate(location.pathname + location.search + location.hash, { replace: true, state: null });
  }, [location, navigate]);
  return null;
}
