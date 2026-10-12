import { PageHeading } from "@/components/PageHeading";
import { Feedback } from "@/components/Feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CollectionSettings } from "@/dashboard/CollectionSettings";
import { useDashboard } from "@/dashboard/useDashboard";

export function SettingsPage() {
  const dashboard = useDashboard();
  return (
    <main id="app-content" tabIndex={-1} className="app-page app-page-form">
      {!dashboard.data && (
        <PageHeading
          title="Réglages"
          description="Choisissez votre rythme et les sujets qui comptent pour vous."
        />
      )}
      <Feedback error message={dashboard.error} />
      {dashboard.error && (
        <Button variant="outline" onClick={() => void dashboard.refresh()}>
          Réessayer
        </Button>
      )}
      {dashboard.loading ? (
        <div role="status" aria-label="Chargement des réglages" className="space-y-5">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        dashboard.data && (
          <CollectionSettings collection={dashboard.data.collection} onSaved={dashboard.refresh} />
        )
      )}
    </main>
  );
}
