import { Link } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import { useCollection } from "./CollectionProvider";

export function CollectionBanner() {
  const { run, busy, error } = useCollection();
  if (!busy) return null;
  const total = run?.total;
  const percent = total ? Math.min(100, Math.round((run!.completed / total) * 100)) : 0;
  return (
    <aside aria-label="Récupération en cours" className="mx-auto mt-5 max-w-6xl px-5">
      <div className="space-y-3 rounded-lg border bg-primary/5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="flex items-center gap-2 font-medium">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Récupération en cours
          </p>
          <Link to="/jobs" className="text-sm underline underline-offset-4">
            Voir les jobs
          </Link>
        </div>
        <div
          role="progressbar"
          aria-label="Articles traités"
          aria-valuemin={0}
          aria-valuemax={total || undefined}
          aria-valuenow={total ? run!.completed : undefined}
          aria-valuetext={
            total === null || total === undefined
              ? "Recensement des articles"
              : `${run!.completed} sur ${total} articles traités`
          }
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={`h-full rounded-full bg-primary ${total === null || total === undefined ? "w-1/4 animate-pulse" : "transition-[width]"}`}
            style={
              total !== null && total !== undefined
                ? { width: `${total === 0 ? 100 : percent}%` }
                : undefined
            }
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {error ||
            (run?.state === "waiting"
              ? "En attente d'un worker disponible."
              : total === null || total === undefined
                ? "Recensement des articles…"
                : `${run!.completed}/${total} articles traités${run!.failed ? ` · ${run!.failed} en échec` : ""}${run!.skipped ? ` · ${run!.skipped} ignorés` : ""}`)}
        </p>
      </div>
    </aside>
  );
}
