import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { AuthProvider } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AuthPage } from "./pages/AuthPage";
import { AppLayout } from "./components/AppLayout";
const SourcesPage = lazy(() =>
  import("./pages/SourcesPage").then((module) => ({ default: module.SourcesPage })),
);
const JournalsPage = lazy(() =>
  import("./pages/JournalsPage").then((module) => ({ default: module.JournalsPage })),
);
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })),
);
const NewSourcePage = lazy(() =>
  import("./pages/NewSourcePage").then((module) => ({ default: module.NewSourcePage })),
);
const SourceWorkflowPage = lazy(() =>
  import("./pages/SourceWorkflowPage").then((module) => ({ default: module.SourceWorkflowPage })),
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
            <Route element={<AppLayout />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/sources" element={<SourcesPage />} />
              <Route path="/journals" element={<JournalsPage />} />
              <Route path="/sources/new/rss" element={<NewSourcePage />} />
              <Route path="/sources/new/scraping" element={<NewSourcePage scraping />} />
              <Route path="/sources/:sourceId/workflow" element={<SourceWorkflowPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
