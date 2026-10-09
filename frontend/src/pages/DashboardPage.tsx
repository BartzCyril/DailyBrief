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
            <section aria-label="Configurer votre veille" className="grid gap-5 sm:grid-cols-2">
              {[
                {
                  to: "/sources",
                  label: "Gérer les sources",
                  description: "Ajouter, modifier et tester vos flux RSS et sites.",
                  Icon: Globe,
                },
                {
                  to: "/journals",
                  label: "Gérer les journaux",
                  description: "Activer les journaux et configurer leur accès.",
                  Icon: Newspaper,
                },
              ].map(({ to, label, description, Icon }) => (
                <div key={to} className="space-y-4 rounded-xl border bg-card p-5">
                  <p className="text-sm text-muted-foreground">{description}</p>
                  <Button asChild variant="outline">
                    <Link to={to}>
                      <Icon />
                      {label}
                    </Link>
                  </Button>
                </div>
              ))}
            </section>
          </>
        )
      )}
    </main>
  );
}
