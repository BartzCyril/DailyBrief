import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { Mail, LogOut } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "./ui/button";
import { Feedback } from "./Feedback";
import { errorMessage } from "@/lib/api";

export function AppLayout() {
  const auth = useAuth();
  const [error, setError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  async function logout() {
    setLoggingOut(true);
    setError("");
    try {
      await auth.logout();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoggingOut(false);
    }
  }
  return (
    <>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-5 px-5 py-5">
          <Link to="/dashboard" className="flex items-center gap-2 text-xl font-semibold">
            <Mail className="text-primary" aria-hidden="true" />
            DailyBrief
          </Link>
          <div className="flex flex-wrap items-center gap-4">
            <span className="break-all text-sm text-muted-foreground">{auth.user?.email}</span>
            <Button variant="ghost" onClick={() => void logout()} disabled={loggingOut}>
              <LogOut aria-hidden="true" />
              {loggingOut ? "Déconnexion…" : "Se déconnecter"}
            </Button>
          </div>
          <nav aria-label="Navigation principale" className="flex w-full flex-wrap gap-3">
            {[
              ["/dashboard", "Tableau de bord"],
              ["/sources", "Sources"],
              ["/journals", "Journaux"],
            ].map(([to, label]) => (
              <NavLink
                key={to}
                to={to!}
                className={({ isActive }) =>
                  `rounded-md px-4 py-2 text-sm font-medium outline-offset-4 ${isActive ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          {error && <Feedback error message={error} />}
        </div>
      </header>
      <Outlet />
    </>
  );
}
