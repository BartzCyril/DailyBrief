import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { WorkflowPreview, WorkflowSummary, CollectionProgress } from "@dailybrief/shared";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/components/Feedback";
import { CollectionProgress as ProgressLog } from "@/dashboard/CollectionProgress";
import { sourcesApi, summarizeWorkflowArticle, validHttpUrl } from "@/sources/api";
import { errorMessage } from "@/lib/api";
import { JournalTable } from "@/sources/JournalTable";

type ArticleTest = {
  busy: boolean;
  events: CollectionProgress[];
  result?: WorkflowSummary;
  error?: string;
};

export function SourceWorkflowPage() {
  const { sourceId = "" } = useParams();
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [tests, setTests] = useState<Record<number, ArticleTest>>({});
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    const controller = new AbortController();
    const active = controllers.current;
    setLoading(true);
    setError("");
    setPreview(null);
    setTests({});
    void sourcesApi
      .workflow(sourceId, controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) setPreview(value);
        },
        (error) => {
          if (!controller.signal.aborted) setError(errorMessage(error));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      active.forEach((item) => item.abort());
      active.clear();
    };
  }, [sourceId, reload]);

  async function summarize(index: number) {
    if (!preview || tests[index]?.busy) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    setTests((previous) => ({ ...previous, [index]: { busy: true, events: [] } }));
    try {
      const result = await summarizeWorkflowArticle(
        sourceId,
        preview.id,
        index,
        (event) => {
          if (!controller.signal.aborted)
            setTests((previous) => ({
              ...previous,
              [index]: { ...previous[index]!, events: [...previous[index]!.events, event] },
            }));
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setTests((previous) => ({
          ...previous,
          [index]: { ...previous[index]!, result },
        }));
    } catch (error) {
      if (!controller.signal.aborted)
        setTests((previous) => ({
          ...previous,
          [index]: { ...previous[index]!, error: errorMessage(error) },
        }));
    } finally {
      controllers.current.delete(controller);
      if (!controller.signal.aborted)
        setTests((previous) => ({
          ...previous,
          [index]: { ...previous[index]!, busy: false },
        }));
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-8">
      <Link to="/dashboard" className="text-sm text-primary underline">
        ← Retour aux sources
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Tester le workflow de A à Z</CardTitle>
          <CardDescription>
            Récupérez les articles et testez leur résumé à partir de leur page complète. Les
            articles déjà traités restent disponibles ici. Aucun mail n'est envoyé et les données de
            collecte restent inchangées.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {preview && (
            <p className="break-all text-sm">
              {preview.source.type} · {preview.source.url}
            </p>
          )}
          <Button
            variant="outline"
            disabled={loading || Object.values(tests).some((test) => test.busy)}
            onClick={() => setReload((value) => value + 1)}
          >
            {loading ? "Récupération des articles…" : "Récupérer à nouveau les articles"}
          </Button>
          {loading && (
            <p role="status" className="text-sm">
              Récupération des articles de la source en cours…
            </p>
          )}
          <Feedback message={error} error />
          {preview?.warnings?.map((warning, index) => (
            <p key={index} className="text-sm text-muted-foreground">
              {warning}
            </p>
          ))}
          {preview && (
            <p role="status" className="text-sm">
              {preview.articles.length} articles récupérés. Cet aperçu est disponible pendant 30
              minutes.
            </p>
          )}
          {preview && !preview.articles.length && <p>Aucun article trouvé dans cette source.</p>}
        </CardContent>
      </Card>
      {preview?.journals && (
        <JournalTable
          journals={preview.journals}
          onChange={(journal) =>
            setPreview((previous) =>
              previous
                ? {
                    ...previous,
                    journals: previous.journals?.map((item) =>
                      item.domain === journal.domain ? journal : item,
                    ),
                  }
                : previous,
            )
          }
        />
      )}
      {preview?.articles.some((article) => article.resolutionError) && (
        <section aria-label="Erreurs de résolution" className="rounded-md border p-4">
          <h2 className="font-semibold">Notices non résolues</h2>
          <ul className="list-disc pl-5">
            {preview.articles
              .filter((article) => article.resolutionError)
              .map((article, index) => (
                <li key={index}>
                  {article.title} : {article.resolutionError}
                </li>
              ))}
          </ul>
        </section>
      )}
      {preview?.articles.map((article, index) => {
        const test = tests[index];
        const articleUrl =
          test?.result?.url ?? (preview.journals ? article.externalUrl : article.url);
        const journal = preview.journals?.find((item) => item.domain === article.journalDomain);
        const ignored = Boolean(preview.journals && (!article.externalUrl || !journal?.enabled));
        return (
          <Card key={`${preview.id}-${index}`}>
            <CardHeader>
              <CardTitle>
                {index + 1}. {article.title}
              </CardTitle>
              {article.description && <CardDescription>{article.description}</CardDescription>}
            </CardHeader>
            <CardContent className="space-y-4">
              {articleUrl && validHttpUrl(articleUrl) && (
                <a
                  href={articleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block break-all text-sm text-primary underline"
                >
                  Lire l'article original
                </a>
              )}
              {ignored && (
                <p className="text-sm">
                  Article ignoré :{" "}
                  {article.resolutionError ? "lien non résolu" : "journal désactivé"}.
                </p>
              )}
              <Button
                disabled={test?.busy || !article.url || ignored}
                onClick={() => void summarize(index)}
              >
                {test?.busy
                  ? "Résumé en cours…"
                  : test?.result
                    ? "Refaire le résumé avec l'IA"
                    : "Faire le résumé avec l'IA"}
              </Button>
              {!article.url && (
                <p className="text-sm text-muted-foreground">
                  Cet article ne fournit pas de lien vers sa page complète.
                </p>
              )}
              {test && (
                <ProgressLog events={test.events} busy={test.busy} completedLabel="Test terminé" />
              )}
              <Feedback message={test?.error ?? ""} error />
              {test?.result && (
                <section
                  aria-label={`Résumé IA de ${article.title}`}
                  className="space-y-3 rounded-md border bg-muted/30 p-4"
                >
                  <h3 className="font-semibold">{test.result.summary.title}</h3>
                  <p className="whitespace-pre-wrap text-sm">{test.result.summary.summary}</p>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {test.result.summary.keyPoints.map((point, i) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">
                      Voir le texte extrait ({test.result.content.length} caractères)
                    </summary>
                    <p className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-sm">
                      {test.result.content}
                    </p>
                  </details>
                </section>
              )}
            </CardContent>
          </Card>
        );
      })}
    </main>
  );
}
