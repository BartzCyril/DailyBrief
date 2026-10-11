import { Link } from "react-router-dom";
import { Clock, Settings2 } from "lucide-react";
import type { Dashboard } from "@dailybrief/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { dateLabel } from "./date-label";

export function CollectionSchedule({ collection }: { collection: Dashboard["collection"] }) {
  return (
    <Card>
      <CardHeader>
        <div className="panel-heading">
          <span className="panel-icon">
            <Clock className="size-5" aria-hidden="true" />
          </span>
          <CardTitle>Votre rythme de veille</CardTitle>
        </div>
        <CardDescription>
          {collection.enabled
            ? `Chaque jour à ${collection.time} · ${collection.timezone}`
            : "Collecte automatique désactivée"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid sm:grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground mb-1">Dernière collecte</dt>
            <dd>{dateLabel(collection.lastRunAt, collection.timezone)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground mb-1">Prochaine collecte</dt>
            <dd>
              {collection.enabled && collection.nextRunAt
                ? dateLabel(collection.nextRunAt, collection.timezone)
                : "Non planifiée"}
            </dd>
          </div>
        </dl>
        <Button asChild variant="outline" size="sm">
          <Link to="/settings">
            <Settings2 aria-hidden="true" />
            Modifier les réglages
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
