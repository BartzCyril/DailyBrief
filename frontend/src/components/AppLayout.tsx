import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { BookOpen, History, LayoutDashboard, LogOut, Newspaper, Rss } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "./ui/button";
import { Feedback } from "./Feedback";
import { errorMessage } from "@/lib/api";
import { CollectionProvider } from "@/collection/CollectionProvider";
import { CollectionBanner } from "@/collection/CollectionBanner";
import { Brand } from "./Brand";

const navigation = [
  { to: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { to: "/sources", label: "Sources", icon: Rss },
  { to: "/journals", label: "Journaux", icon: Newspaper },
  { to: "/jobs", label: "Historique d’exécutions", icon: History },
  { to: "/documentation", label: "Documentation", icon: BookOpen },
];

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
    <CollectionProvider>
      <div className="app-shell">
        <a href="#app-content" className="skip-link">
          Aller au contenu
        </a>
        <header className="app-header">
          <div className="app-header-inner">
            <div className="app-header-top">
              <Brand to="/dashboard" label="DailyBrief, tableau de bord" />
              <div className="app-account">
                <span className="app-account-email" title={auth.user?.email}>
                  {auth.user?.email}
                </span>
                <Button
                  variant="ghost"
                  onClick={() => void logout()}
                  disabled={loggingOut}
                  aria-label={loggingOut ? "Déconnexion…" : "Se déconnecter"}
                  title="Se déconnecter"
                >
                  <LogOut aria-hidden="true" />
                  <span className="app-logout-label">
                    {loggingOut ? "Déconnexion…" : "Se déconnecter"}
                  </span>
                </Button>
              </div>
            </div>
            <nav aria-label="Navigation principale" className="app-navigation">
              {navigation.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} className="app-nav-link">
                  <Icon aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </nav>
            {error && <Feedback error message={error} />}
          </div>
        </header>
        <CollectionBanner />
        <Outlet />
      </div>
    </CollectionProvider>
  );
}
