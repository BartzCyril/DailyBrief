import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  ArticleJobsPage,
  ArticleJobStatus,
  CollectionRunSnapshot,
  QueueState,
} from "@dailybrief/shared";
import { articleJobStatuses } from "@dailybrief/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useCollection } from "@/collection/CollectionProvider";
import { CollectionProgress } from "@/dashboard/CollectionProgress";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { ArticleSummaryDialog } from "@/collection/ArticleSummaryDialog";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeading } from "@/components/PageHeading";

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
  const [result, setResult] = useState<{ data: ArticleJobsPage; key: string } | null>(null);
  const [params, setParams] = useSearchParams();
  const requestedPage = Number(params.get("page") ?? 1);
  const page =
    Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 100000
      ? requestedPage
      : 1;
  const requestedStatus = params.get("status") ?? "all";
  const status: ArticleJobStatus = articleJobStatuses.includes(requestedStatus as ArticleJobStatus)
    ? (requestedStatus as ArticleJobStatus)
    : "all";
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const id = selected ?? current?.id;
  const key = JSON.stringify([id, page, status]);
  const jobs = result?.key === key ? result.data : null;
  function setPage(next: number, replace = false) {
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        if (next === 1) updated.delete("page");
        else updated.set("page", String(next));
        return updated;
      },
      { replace },
    );
  }
  function setStatus(next: ArticleJobStatus) {
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      updated.delete("page");
      if (next === "all") updated.delete("status");
      else updated.set("status", next);
      return updated;
    });
  }
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setLoading(true);
    async function refresh() {
      let active = false;
      try {
        const [runs, detail, rows] = await Promise.all([
          api<CollectionRunSnapshot[]>("/collection/runs", { signal: controller.signal }),
          id
            ? api<CollectionRunSnapshot>(`/collection/runs/${id}`, { signal: controller.signal })
            : null,
          id
            ? api<ArticleJobsPage>(`/collection/runs/${id}/jobs?page=${page}&status=${status}`, {
                signal: controller.signal,
              })
            : null,
        ]);
        if (stopped) return;
        setHistory(runs);
        setRun(detail);
        setResult(rows ? { data: rows, key: JSON.stringify([id, rows.page, status]) } : null);
        if (rows && rows.page !== page) setPage(rows.page, true);
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
  }, [id, page, status, retry]);
  const currentPage = jobs?.page ?? page;
  const pageSize = jobs?.pageSize ?? 5;
  const total = jobs?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (currentPage - 1) * pageSize;
  return (
    <main id="app-content" tabIndex={-1} className="app-page app-page-wide">
      <PageHeading
        title="Historique d’exécutions"
        description="Suivez l'extraction, les résumés IA et l'envoi de votre brief."
        actions={
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
        }
      />
      <Feedback error message={error || collectionError} />
      {error && (
        <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
          Réessayer
        </Button>
      )}
      {loading && <p role="status">Chargement de l’historique…</p>}
      {!loading && !history.length && !error && (
        <p>
          Aucune récupération.{" "}
          <Link to="/sources" className="underline underline-offset-4">
            Configurer les sources
          </Link>
        </p>
      )}
      <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:items-start">
        <aside
          aria-label="Suivi de la collecte"
          className="min-w-0 space-y-5 lg:w-72 xl:w-80 lg:shrink-0"
        >
          {!!history.length && (
            <div className="space-y-2">
              <Label htmlFor="collection-run">Récupération</Label>
              <NativeSelect
                id="collection-run"
                value={id ?? ""}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setPage(1);
                  setResult(null);
                  setRun(null);
                }}
              >
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    {new Date(item.startedAt).toLocaleString("fr-FR")} ·{" "}
                    {item.trigger === "scheduled" ? "Quotidienne" : "Manuelle"} ·{" "}
                    {labels[item.state]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          {run && (
            <section className="app-panel space-y-4" aria-label="État de la récupération">
              <div className="flex flex-wrap justify-between gap-3">
                <p className="font-medium">{labels[run.state]}</p>
                <p className="text-sm">
                  {run.total === null
                    ? "Recensement des articles"
                    : `${run.completed}/${run.total} articles traités · ${run.failed} en échec · ${run.skipped} ignorés`}
                </p>
              </div>
              <Feedback inline error message={run.error ?? ""} />
              {run.result?.status === "SENT" && <p>Newsletter envoyée.</p>}
              {run.result?.status === "NO_NEW_ARTICLES" && <p>Aucun nouvel article à envoyer.</p>}
              <CollectionProgress events={run.events} busy={run.active} />
            </section>
          )}
        </aside>
        {!!history.length && (
          <section className="min-w-0 flex-1 space-y-4" aria-label="Traitement des articles">
            <div className="grid max-w-xs gap-2">
              <Label htmlFor="article-job-status">Statut des articles</Label>
              <NativeSelect
                id="article-job-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as ArticleJobStatus)}
              >
                <option value="all">Tous les statuts</option>
                <option value="waiting">En attente</option>
                <option value="active">En cours</option>
                <option value="completed">Terminé</option>
                <option value="failed">Échec</option>
                <option value="skipped">Ignoré</option>
              </NativeSelect>
            </div>
            <div
              className="app-table-frame"
              aria-busy={loading}
              tabIndex={0}
              role="region"
              aria-label="Tableau des articles, défilement horizontal"
            >
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
                    <th scope="col" className="px-4 py-3">
                      Résumé IA
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {jobs?.jobs.map((job) => (
                    <tr key={job.id} className="border-b last:border-0">
                      <td className="min-w-44 px-4 py-4">
                        <p className="font-medium">{job.title}</p>
                      </td>
                      <td className="min-w-36 px-4 py-4">
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
                          className={`inline-flex items-center gap-2 whitespace-nowrap ${job.state === "failed" ? "text-destructive" : ""}`}
                        >
                          <span
                            aria-hidden="true"
                            className={`size-2 shrink-0 rounded-full ${job.state === "failed" ? "bg-red-500" : job.state === "completed" ? "bg-green-600" : "bg-amber-500"}`}
                          />
                          {job.skipped ? "Ignoré" : labels[job.state]}
                        </span>
                      </td>
                      <td className="px-4 py-4">{job.attempts}</td>
                      <td className="min-w-40 px-4 py-4">
                        {job.error ?? job.progress?.message ?? "—"}
                      </td>
                      <td className="px-4 py-4">
                        {job.summary ? (
                          <ArticleSummaryDialog articleTitle={job.title} summary={job.summary} />
                        ) : (
                          <span className="text-muted-foreground" aria-label="Résumé indisponible">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!jobs?.jobs.length && (
                <p className="p-4 text-muted-foreground">
                  {loading
                    ? "Chargement des articles…"
                    : status !== "all"
                      ? "Aucun article ne correspond à ce statut."
                      : run?.active
                        ? "Les articles apparaîtront après le recensement."
                        : "Aucun article à traiter pour cette récupération."}
                </p>
              )}
            </div>
            <nav
              aria-label="Pagination des articles"
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {total ? `${offset + 1}–${Math.min(offset + pageSize, total)} sur ${total}` : "0"}{" "}
                article{total === 1 ? "" : "s"}
              </p>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Page précédente"
                  disabled={loading || !jobs || currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <span className="text-sm">
                  Page {currentPage} sur {pages}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Page suivante"
                  disabled={loading || !jobs || currentPage >= pages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </nav>
          </section>
        )}
      </div>
    </main>
  );
}
