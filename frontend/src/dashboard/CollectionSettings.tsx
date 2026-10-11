import { useEffect, useState, type FormEvent } from "react";
import type { Dashboard } from "@dailybrief/shared";
import { Clock, LoaderCircle } from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import { Feedback } from "@/components/Feedback";
import { dashboardApi } from "./api";
import { errorMessage } from "@/lib/api";
import { browserTimezone } from "@/lib/timezone";
export function dateLabel(value: string | null, timezone: string): string {
  return value
    ? new Intl.DateTimeFormat("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      }).format(new Date(value))
    : "Jamais exécutée";
}
export function CollectionSettings({
  collection,
  onSaved,
}: {
  collection: Dashboard["collection"];
  onSaved: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(collection.enabled);
  const [time, setTime] = useState(collection.time);
  const timezone = browserTimezone() ?? collection.timezone;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const changed = enabled !== collection.enabled || time !== collection.time;
  useEffect(() => {
    setEnabled(collection.enabled);
    setTime(collection.time);
  }, [collection.enabled, collection.time]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !changed) return;
    setError("");
    setMessage("");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      setError("Choisissez une heure valide.");
      return;
    }
    setBusy(true);
    try {
      await dashboardApi.saveSettings({
        collectionEnabled: enabled,
        collectionTime: time,
        timezone,
      });
      await onSaved();
      setMessage("Réglages enregistrés.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <div className="panel-heading">
          <span className="panel-icon">
            <Clock className="size-5" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <CardTitle>Collecte automatique</CardTitle>
            <CardDescription>Votre veille à l'heure qui vous convient.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-5">
          <div className="flex justify-between items-center gap-4">
            <div>
              <Label htmlFor="auto-collection">Récupération automatique</Label>
              <p className="text-sm text-muted-foreground mt-1">
                {enabled ? "Activée chaque jour" : "Désactivée · collecte manuelle disponible"}
              </p>
            </div>
            <Switch
              id="auto-collection"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={busy}
            />
          </div>
          <fieldset disabled={busy}>
            <Field
              label="Heure quotidienne"
              hint="Heure locale de lancement. Le fuseau horaire est détecté automatiquement."
              type="time"
              required
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </fieldset>
          <div className="grid sm:grid-cols-2 gap-4 rounded-lg bg-muted p-4 text-sm">
            <div>
              <p className="text-muted-foreground mb-1">Dernière collecte</p>
              <p>{dateLabel(collection.lastRunAt, timezone)}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-1">Prochaine collecte</p>
              <p>
                {collection.enabled && collection.nextRunAt
                  ? dateLabel(collection.nextRunAt, timezone)
                  : "Non planifiée"}
              </p>
            </div>
          </div>
          <Feedback message={error} error />
          <Feedback message={message} />
          <Button type="submit" disabled={busy || !changed}>
            {busy && <LoaderCircle className="animate-spin" />}
            {busy ? "Enregistrement…" : "Enregistrer les réglages"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
