import { useEffect, useRef, useState } from "react";
import type { CollectionProgress as Progress } from "@dailybrief/shared";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Feedback } from "@/components/Feedback";
import { streamCollection } from "./collection-stream";
import { CollectionProgress } from "./CollectionProgress";
import { errorMessage } from "@/lib/api";
export function ManualCollection({ onComplete }: { onComplete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<Progress[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function run() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    setEvents([]);
    controller.current = new AbortController();
    try {
      const result = await streamCollection(
        (progress) => setEvents((previous) => [...previous, progress]),
        controller.current.signal,
      );
      if (result.status === "FAILED")
        setError(
          result.failure?.message ??
            "La collecte n'a pas pu aboutir. Consultez les étapes ci-dessous.",
        );
      else
        setMessage(
          result.status === "NO_NEW_ARTICLES"
            ? "Aucun nouvel article à envoyer."
            : "Votre newsletter a été envoyée.",
        );
      await onComplete();
    } catch (error) {
      if (controller.current?.signal.aborted) return;
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Un brief, maintenant</CardTitle>
        <CardDescription>
          Récupérez les nouveaux articles sans attendre la prochaine collecte.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={() => void run()} disabled={busy} className="w-full">
          <RefreshCw className={busy ? "animate-spin" : ""} />
          {busy ? "Collecte en cours…" : "Récupérer maintenant"}
        </Button>
        <CollectionProgress events={events} busy={busy} />
        <Feedback message={error} error />
        <Feedback message={message} />
        <p className="text-xs text-muted-foreground">
          Les articles déjà envoyés sont exclus de votre prochain brief.
        </p>
      </CardContent>
    </Card>
  );
}
