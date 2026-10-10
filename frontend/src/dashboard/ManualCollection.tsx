import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Feedback } from "@/components/Feedback";
import { useCollection } from "@/collection/CollectionProvider";
import { CollectionProgress } from "./CollectionProgress";
export function ManualCollection({ onComplete }: { onComplete: () => Promise<void> }) {
  const { run, busy, error, start } = useCollection();
  const lastCompleted = useRef<string | null>(null);
  useEffect(() => {
    if (run && !run.active && run.finishedAt && lastCompleted.current !== run.id) {
      lastCompleted.current = run.id;
      void onComplete().catch(() => {});
    }
  }, [run, onComplete]);
  const failure =
    run?.result?.status === "FAILED"
      ? (run.result.failure?.message ?? "La collecte n'a pas pu aboutir. Consultez les jobs.")
      : !run?.active
        ? run?.error
        : null;
  const message =
    run?.result?.status === "SENT"
      ? "Votre newsletter a été envoyée."
      : run?.result?.status === "NO_NEW_ARTICLES"
        ? "Aucun nouvel article à envoyer."
        : "";
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Un brief, maintenant</CardTitle>
        <CardDescription>
          Récupérez les nouveaux articles sans attendre la prochaine collecte.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={() => void start()} disabled={busy} className="w-full">
          <RefreshCw className={busy ? "animate-spin" : ""} />
          {busy ? "Collecte en cours…" : "Récupérer maintenant"}
        </Button>
        <CollectionProgress events={run?.events ?? []} busy={busy} />
        <Feedback message={error || failure || ""} error />
        <Feedback message={message} />
        <p className="text-xs text-muted-foreground">
          Les articles déjà envoyés sont exclus de votre prochain brief.
        </p>
      </CardContent>
    </Card>
  );
}
