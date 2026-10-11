import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, BookOpen, ArrowUpRight } from "lucide-react";
import type { DailyBriefArticlesPage } from "@dailybrief/shared";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { api, errorMessage } from "@/lib/api";
import { validHttpUrl } from "@/sources/api";

export function BriefArticlesDialog({ briefId, timezone }: { briefId: string; timezone: string }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ key: string; data: DailyBriefArticlesPage } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const key = `${briefId}:${page}`;
  const articles = result?.key === key ? result.data : null;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<DailyBriefArticlesPage>(
      `/dailybrief/${encodeURIComponent(briefId)}/articles?page=${page}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({ key: `${briefId}:${data.page}`, data });
        if (data.page !== page) setPage(data.page);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, briefId, page, retry]);
  const total = articles?.total ?? 0;
  const pageSize = articles?.pageSize ?? 5;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setPage(1);
          setResult(null);
          setError("");
        }
      }}
      title="Résumés individuels"
      description="Les articles utilisés pour cette édition du Daily Brief."
      trigger={
        <Button variant="outline" size="sm">
          <BookOpen aria-hidden="true" />
          Lire les résumés individuels
        </Button>
      }
    >
      <div className="min-w-0 space-y-5">
        {loading && <p role="status">Chargement des résumés…</p>}
        <Feedback inline error message={error} />
        {error && (
          <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
            Réessayer
          </Button>
        )}
        {articles && (
          <>
            <ol aria-label="Articles de cette édition" className="space-y-4">
              {articles.articles.map((article) => (
                <li key={article.id} className="rounded-xl border bg-card p-4 sm:p-5">
                  <h3 className="break-words text-base font-medium leading-relaxed">
                    {article.title}
                  </h3>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    {article.publishedAt && (
                      <time dateTime={article.publishedAt}>
                        {new Intl.DateTimeFormat("fr-FR", {
                          dateStyle: "medium",
                          timeZone: timezone,
                        }).format(new Date(article.publishedAt))}
                      </time>
                    )}
                    {article.url && validHttpUrl(article.url) && (
                      <a
                        href={article.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 underline underline-offset-4"
                      >
                        Lire l’article original
                        <ArrowUpRight className="size-3" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                  <details className="mt-4">
                    <summary className="cursor-pointer rounded-md text-sm font-medium text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
                      Lire le résumé
                      <span className="sr-only"> de {article.title}</span>
                    </summary>
                    <div className="mt-4 space-y-4 break-words text-sm leading-relaxed">
                      <p className="whitespace-pre-line">{article.summary}</p>
                      {!!article.keyPoints.length && (
                        <div className="space-y-2">
                          <h4 className="font-medium">Points clés</h4>
                          <ul className="list-disc space-y-2 pl-5">
                            {article.keyPoints.map((point, index) => (
                              <li key={index}>{point}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ol>
            {!articles.articles.length && (
              <p className="text-sm text-muted-foreground">
                Aucun résumé disponible pour cette édition.
              </p>
            )}
            <nav
              aria-label="Pagination des résumés"
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {total ? `${offset + 1}–${Math.min(offset + pageSize, total)} sur ${total}` : "0"}{" "}
                article{total === 1 ? "" : "s"}
              </p>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Page précédente des résumés"
                  disabled={loading || page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <span className="text-sm">
                  Page {page} sur {pages}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Page suivante des résumés"
                  disabled={loading || page >= pages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </nav>
          </>
        )}
      </div>
    </Modal>
  );
}
