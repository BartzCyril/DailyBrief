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
  const [timezone, setTimezone] = useState(collection.timezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const changed =
    enabled !== collection.enabled || time !== collection.time || timezone !== collection.timezone;
  useEffect(() => {
    setEnabled(collection.enabled);
    setTime(collection.time);
    setTimezone(collection.timezone);
  }, [collection.enabled, collection.time, collection.timezone]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !changed) return;
    setError("");
    setMessage("");
    try {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Choisissez une heure valide.");
      new Intl.DateTimeFormat("fr-FR", { timeZone: timezone }).format();
    } catch {
      setError("Vérifiez l'heure et le fuseau horaire IANA.");
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
        <CardTitle className="flex gap-2 items-center">
          <Clock className="size-5" />
          Collecte automatique
        </CardTitle>
        <CardDescription>Votre veille à l'heure qui vous convient.</CardDescription>
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
          <fieldset disabled={busy} className="grid sm:grid-cols-2 gap-4">
            <Field
              label="Heure quotidienne"
              hint="Heure de lancement de la collecte, dans le fuseau horaire indiqué."
              type="time"
              required
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
            <Field
              label="Fuseau horaire"
              hint="Nom du fuseau horaire, par exemple Europe/Paris."
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </fieldset>
          <div className="grid sm:grid-cols-2 gap-4 rounded-lg bg-muted p-4 text-sm">
            <div>
              <p className="text-muted-foreground mb-1">Dernière collecte</p>
              <p>{dateLabel(collection.lastRunAt, collection.timezone)}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-1">Prochaine collecte</p>
              <p>
                {collection.enabled && collection.nextRunAt
                  ? dateLabel(collection.nextRunAt, collection.timezone)
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
