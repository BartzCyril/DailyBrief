import { Link, useLocation } from "react-router-dom";
import { Globe, Newspaper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Feedback } from "@/components/Feedback";
import { Statistics } from "@/dashboard/Statistics";
import { CollectionSettings } from "@/dashboard/CollectionSettings";
import { ManualCollection } from "@/dashboard/ManualCollection";
import { useDashboard } from "@/dashboard/useDashboard";
export function DashboardPage() {
  const dashboard = useDashboard();
  const location = useLocation();
  const notification: unknown = location.state;
  const message =
    notification &&
    typeof notification === "object" &&
    "message" in notification &&
    typeof notification.message === "string"
      ? notification.message
      : "";
  return (
    <main className="max-w-6xl mx-auto px-5 py-9 space-y-7">
      <div>
        <p className="uppercase tracking-widest text-xs text-muted-foreground mb-2">
          Votre espace de veille
        </p>
        <h1 tabIndex={-1} className="text-3xl font-semibold">
          Votre DailyBrief
        </h1>
        <p className="mt-2 text-muted-foreground">
          Vos sources, votre rythme, l'essentiel dans votre boîte mail.
        </p>
      </div>
      <Feedback message={message} />
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
