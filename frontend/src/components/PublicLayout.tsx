import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { ArrowUpRight, Mail } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";

export function PublicLayout() {
  const { user } = useAuth();
  const { pathname, hash } = useLocation();
  useEffect(
    () => () => {
      document.title = "DailyBrief";
    },
    [],
  );
  useEffect(() => {
    document.title =
      pathname === "/documentation"
        ? "Guide d’utilisation · DailyBrief"
        : "DailyBrief · Votre veille, l’essentiel chaque matin";
    if (hash) {
      const frame = requestAnimationFrame(() => {
        let id = hash.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          /* A malformed fragment must not break the page. */
        }
        const target = document.getElementById(id);
        target?.scrollIntoView({ block: "start" });
        target?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return (
    <div className="public-site">
      <a className="public-skip" href="#contenu">
        Aller au contenu
      </a>
      <header className="public-header">
        <div className="public-nav public-container">
          <Link to="/" className="public-brand" aria-label="DailyBrief, accueil">
            <span className="brand-symbol">
              <Mail aria-hidden="true" size={21} />
            </span>
            DailyBrief<span className="brand-dot">.</span>
          </Link>
          <nav aria-label="Navigation publique" className="public-links">
            <NavLink to="/" end>
              Le produit
            </NavLink>
            <NavLink to="/documentation">Documentation</NavLink>
          </nav>
          <Link className="public-button public-button-small" to={user ? "/dashboard" : "/login"}>
            {user ? "Mon espace" : "Se connecter"}
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </header>
      <Outlet />
      <footer className="public-footer public-container">
        <div>
          <Link to="/" className="public-brand">
            <Mail size={20} aria-hidden="true" /> DailyBrief.
          </Link>
          <p>Un peu moins d’onglets. Un peu plus de recul.</p>
        </div>
        <nav aria-label="Navigation de pied de page">
          <Link to="/documentation">Guide d’utilisation</Link>
          <Link to={user ? "/dashboard" : "/register"}>
            {user ? "Ouvrir mon espace" : "Créer un compte"}
          </Link>
        </nav>
        <span>Fait pour les esprits curieux.</span>
      </footer>
    </div>
  );
}
