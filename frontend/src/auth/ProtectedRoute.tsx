import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
export function ProtectedRoute() {
  const auth = useAuth();
  if (auth.loading)
    return (
      <main className="p-8" role="status">
        Vérification de votre session…
      </main>
    );
  if (auth.error)
    return (
      <main className="p-8 space-y-4">
        <Feedback error message={auth.error} />
        <Button onClick={() => void auth.refresh()}>Réessayer</Button>
      </main>
    );
  return auth.user ? <Outlet /> : <Navigate to="/login" replace />;
}
