import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ArticleJobsPage, CollectionRunSnapshot, QueueState } from "@dailybrief/shared";
import { api, errorMessage } from "@/lib/api";
import { useCollection } from "@/collection/CollectionProvider";
import { CollectionProgress } from "@/dashboard/CollectionProgress";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";

const labels: Record<QueueState, string> = {
  waiting: "En attente",
  active: "En cours",
  delayed: "Nouvelle tentative prévue",
  completed: "Terminé",
  failed: "Échec",
};
export function JobsPage() {
  const { run: current, busy, start, error: collectionError } = useCollection();
  const [history, setHistory] = useState<CollectionRunSnapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [run, setRun] = useState<CollectionRunSnapshot | null>(null);
  const [jobs, setJobs] = useState<ArticleJobsPage | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const id = selected ?? current?.id;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      let active = false;
      try {
        const [runs, detail, rows] = await Promise.all([
          api<CollectionRunSnapshot[]>("/collection/runs", { signal: controller.signal }),
          id
            ? api<CollectionRunSnapshot>(`/collection/runs/${id}`, { signal: controller.signal })
            : null,
          id
            ? api<ArticleJobsPage>(`/collection/runs/${id}/jobs?page=${page}`, {
                signal: controller.signal,
              })
            : null,
        ]);
        if (stopped) return;
        setHistory(runs);
        setRun(detail);
        setJobs(rows);
        setError("");
        active = Boolean(detail?.active);
        if (!id && runs[0]) setSelected(runs[0].id);
      } catch (error) {
        if (!stopped) setError(errorMessage(error));
      } finally {
        if (!stopped) setLoading(false);
      }
      if (!stopped) timer = setTimeout(() => void refresh(), active ? 1500 : 10000);
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [id, page]);
  const pages = Math.max(1, Math.ceil((jobs?.total ?? 0) / (jobs?.pageSize ?? 10)));
  return (
    <main className="mx-auto max-w-6xl space-y-7 px-5 py-9">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold">Jobs de récupération</h1>
          <p className="text-muted-foreground">
            Suivez l'extraction, les résumés IA et l'envoi de votre brief.
          </p>
        </div>
        <Button
          onClick={() => {
            setSelected(null);
            setPage(1);
            void start();
          }}
          disabled={busy}
        >
          {busy ? "Récupération en cours…" : "Récupérer maintenant"}
        </Button>
      </div>
      <Feedback error message={error || collectionError} />
      {loading && <p role="status">Chargement des jobs…</p>}
      {!loading && !history.length && !error && (
        <p>
          Aucune récupération.{" "}
          <Link to="/sources" className="underline underline-offset-4">
            Configurer les sources
          </Link>
        </p>
      )}
      {!!history.length && (
        <div className="space-y-2">
          <label htmlFor="collection-run" className="text-sm font-medium">
            Récupération
          </label>
          <select
            id="collection-run"
            value={id ?? ""}
            onChange={(event) => {
              setSelected(event.target.value);
              setPage(1);
              setJobs(null);
              setRun(null);
            }}
            className="flex min-h-10 w-full rounded-md border bg-background px-3 py-2"
          >
            {history.map((item) => (
              <option key={item.id} value={item.id}>
                {new Date(item.startedAt).toLocaleString("fr-FR")} ·{" "}
                {item.trigger === "scheduled" ? "Quotidienne" : "Manuelle"} · {labels[item.state]}
              </option>
            ))}
          </select>
        </div>
      )}
      {run && (
        <section className="space-y-4 rounded-lg border p-4" aria-label="État de la récupération">
          <div className="flex flex-wrap justify-between gap-3">
            <p className="font-medium">{labels[run.state]}</p>
            <p className="text-sm">
              {run.total === null
                ? "Recensement des articles"
                : `${run.completed}/${run.total} articles traités · ${run.failed} en échec · ${run.skipped} ignorés`}
            </p>
          </div>
          <Feedback error message={run.error ?? ""} />
          {run.result?.status === "SENT" && <p>Newsletter envoyée.</p>}
          {run.result?.status === "NO_NEW_ARTICLES" && <p>Aucun nouvel article à envoyer.</p>}
          <CollectionProgress events={run.events} busy={run.active} />
        </section>
      )}
      {jobs && (
        <section className="space-y-4" aria-label="Jobs des articles">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Article
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Source
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Statut
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Tentatives
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Étape
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.jobs.map((job) => (
                  <tr key={job.id} className="border-b last:border-0">
                    <td className="min-w-44 px-4 py-4">
                      <p className="font-medium">{job.title}</p>
                      <span className="text-xs text-muted-foreground">
                        {job.articleId.slice(-8)}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      {job.sourceUrl && (
                        <a
                          href={job.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all underline underline-offset-4"
                        >
                          {new URL(job.sourceUrl).hostname}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <span
                        className={`inline-flex items-center gap-2 ${job.state === "failed" ? "text-destructive" : ""}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`size-2 shrink-0 rounded-full ${job.state === "failed" ? "bg-red-500" : job.state === "completed" ? "bg-green-600" : "bg-amber-500"}`}
                        />
                        {job.skipped ? "Ignoré" : labels[job.state]}
                      </span>
                    </td>
                    <td className="px-4 py-4">{job.attempts}</td>
                    <td className="min-w-52 px-4 py-4">
                      {job.error ?? job.progress?.message ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!jobs.jobs.length && (
              <p className="p-4 text-muted-foreground">
                {run?.active
                  ? "Les jobs seront créés après le recensement des articles."
                  : "Aucun job d'article pour cette récupération."}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {jobs.total} jobs · Page {page}/{pages}
            </p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                Précédente
              </Button>
              <Button
                variant="outline"
                disabled={page >= pages}
                onClick={() => setPage((value) => value + 1)}
              >
                Suivante
              </Button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
