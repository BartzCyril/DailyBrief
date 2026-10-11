import type { Dashboard } from "@dailybrief/shared";
import { Rss, Globe, Layers, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
export function Statistics({ sources }: { sources: Dashboard["sources"] }) {
  return (
    <section
      aria-label="Statistiques des sources"
      className="grid grid-cols-2 lg:grid-cols-4 gap-4"
    >
      {[
        { label: "Sources totales", count: sources.total, icon: Layers },
        { label: "Flux RSS", count: sources.rss, icon: Rss },
        { label: "Sources scraping", count: sources.scraping, icon: Globe },
        { label: "Sources actives", count: sources.enabled, icon: CheckCircle2 },
      ].map(({ label, count, icon: Icon }) => (
        <Card key={label}>
          <CardContent className="metric-body">
            <div className="metric-top">
              <p className="metric-value">{count}</p>
              <span className="metric-icon">
                <Icon className="size-4" aria-hidden="true" />
              </span>
            </div>
            <p className="metric-label">{label}</p>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
