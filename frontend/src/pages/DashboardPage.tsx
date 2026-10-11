import { Link } from "react-router-dom";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Feedback } from "@/components/Feedback";
import { NavigationFeedback } from "@/components/NavigationFeedback";
import { Statistics } from "@/dashboard/Statistics";
import { CollectionSettings } from "@/dashboard/CollectionSettings";
import { ManualCollection } from "@/dashboard/ManualCollection";
import { useDashboard } from "@/dashboard/useDashboard";
import { PageHeading } from "@/components/PageHeading";
export function DashboardPage() {
  const dashboard = useDashboard();
  return (
    <main id="app-content" tabIndex={-1} className="app-page">
      <PageHeading
        title={
          <>
            Votre <em>DailyBrief</em>
          </>
        }
        eyebrow="Votre espace de veille"
        description="Vos sources, votre rythme, l'essentiel dans votre boîte mail."
        actions={
          <Button asChild variant="outline">
            <Link to="/documentation">
              <BookOpen aria-hidden="true" />
              Guide d’utilisation
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </Button>
        }
      />
      <NavigationFeedback />
      <Feedback error message={dashboard.error} />
      {dashboard.error && (
        <Button variant="outline" onClick={() => void dashboard.refresh()}>
          Réessayer
        </Button>
      )}
      {dashboard.loading ? (
        <div
          role="status"
          aria-label="Chargement du dashboard"
          className="grid sm:grid-cols-2 gap-4"
        >
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : (
        dashboard.data && (
          <>
            <Statistics sources={dashboard.data.sources} />
            <section className="grid lg:grid-cols-[1.6fr_1fr] items-start gap-5">
              <CollectionSettings
                collection={dashboard.data.collection}
                onSaved={dashboard.refresh}
              />
              <ManualCollection onComplete={dashboard.refresh} />
            </section>
          </>
        )
      )}
    </main>
  );
}
