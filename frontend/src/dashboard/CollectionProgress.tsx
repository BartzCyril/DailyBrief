import { useEffect, useRef } from "react";
import { CheckCircle2, CircleX, LoaderCircle, MinusCircle } from "lucide-react";
import type { CollectionProgress as Progress } from "@dailybrief/shared";

const stages = {
  collection: "Collecte",
  source: "Source",
  storage: "Articles",
  content: "Contenu de l'article",
  ai: "Résumé IA",
  newsletter: "Newsletter",
  email: "Email",
};
export function CollectionProgress({
  events,
  busy,
  completedLabel = "Collecte terminée",
}: {
  events: Progress[];
  busy: boolean;
  completedLabel?: string;
}) {
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [events]);
  if (!events.length) return null;
  const current = events.at(-1)!;
  return (
    <section aria-label="Progression de la collecte" className="min-w-0 space-y-3">
      <p className="text-sm font-medium" role="status" aria-live="polite">
        {busy ? `${stages[current.stage]} en cours` : completedLabel}
        {current.total !== undefined && ` · ${current.completed ?? 0}/${current.total}`}
      </p>
      <div
        ref={log}
        role="log"
        aria-label="Étapes de la collecte"
        aria-live="polite"
        aria-relevant="additions"
        className="max-h-80 overflow-y-auto rounded-md border bg-muted/30 p-3"
      >
        <ol className="space-y-3">
          {events.map((event, index) => {
            const Icon =
              event.status === "failed"
                ? CircleX
                : event.status === "completed"
                  ? CheckCircle2
                  : event.status === "skipped"
                    ? MinusCircle
                    : LoaderCircle;
            return (
              <li key={index} className="flex min-w-0 gap-2 text-sm">
                <Icon
                  aria-hidden="true"
                  className={`mt-0.5 size-4 shrink-0 ${event.status === "failed" ? "text-destructive" : "text-muted-foreground"} ${busy && index === events.length - 1 && event.status === "running" ? "animate-spin" : ""}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span>{stages[event.stage]}</span>
                    <time dateTime={event.at}>
                      {new Intl.DateTimeFormat("fr-FR", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      }).format(new Date(event.at))}
                    </time>
                    <span>
                      {event.status === "running"
                        ? busy && index === events.length - 1
                          ? "En cours"
                          : "Démarré"
                        : event.status === "completed"
                          ? "Terminé"
                          : event.status === "failed"
                            ? "Échec"
                            : "Ignoré"}
                    </span>
                  </div>
                  <p className="break-words [overflow-wrap:anywhere]">{event.message}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
