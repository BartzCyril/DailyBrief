import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { AuthProvider } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AuthPage } from "./pages/AuthPage";
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })),
);
const NewSourcePage = lazy(() =>
  import("./pages/NewSourcePage").then((module) => ({ default: module.NewSourcePage })),
);
export function App() {
  return (
    <AuthProvider>
      <Suspense
        fallback={
          <p role="status" className="p-8">
            Chargement…
          </p>
        }
      >
        <Routes>
          <Route path="/login" element={<AuthPage />} />
          <Route path="/register" element={<AuthPage register />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/sources/new/rss" element={<NewSourcePage />} />
            <Route path="/sources/new/scraping" element={<NewSourcePage scraping />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
