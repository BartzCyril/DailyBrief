import type { ArticleJobResult } from "@dailybrief/shared";
import type { Db } from "./db";
import type { CollectedArticle, SourceResult } from "./collection";

export type CollectedReportEntry = {
  articleId: string;
  article: CollectedArticle;
  alreadyStored: boolean;
};
export type ReportTable = { name: string; rows: string[][] };
export type CollectionReport = {
  runId: string;
  date: string;
  tables: ReportTable[];
};

export async function buildCollectionReport(
  db: Db,
  input: {
    userId: string;
    runId: string;
    date: string;
    timezone: string;
    startedAt: Date;
    interestPrompt: string;
    collected: CollectedReportEntry[];
    pendingIds: string[];
    briefArticleIds: string[];
    outcomes: ArticleJobResult[];
    exclusions: Map<string, string>;
    sources: SourceResult[];
  },
): Promise<CollectionReport> {
  const ids = [
    ...new Set([
      ...input.collected.map((entry) => entry.articleId),
      ...input.pendingIds,
      ...input.briefArticleIds,
    ]),
  ];
  const [articles, sources] = await Promise.all([
    db.article.findMany({
      where: { userId: input.userId, id: { in: ids } },
      select: {
        id: true,
        sourceId: true,
        title: true,
        url: true,
        contentUrl: true,
        description: true,
        publishedAt: true,
        relevant: true,
        relevanceReason: true,
        summaryTitle: true,
        summary: true,
        keyPoints: true,
        summarizedAt: true,
        contentError: true,
        summaryError: true,
        newsletters: {
          where: { newsletter: { status: { in: ["SENT", "SENDING"] } } },
          select: { newsletterId: true },
        },
      },
    }),
    db.source.findMany({
      where: { userId: input.userId },
      select: { id: true, url: true, type: true, enabled: true },
    }),
  ]);
  const articleById = new Map(articles.map((article) => [article.id, article]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const outcomeById = new Map(input.outcomes.map((outcome) => [outcome.articleId, outcome]));
  const pending = new Set(input.pendingIds);
  const used = new Set(input.briefArticleIds);
  const entries = [...input.collected];
  const collectedIds = new Set(entries.map((entry) => entry.articleId));
  for (const id of ids) {
    if (collectedIds.has(id)) continue;
    const article = articleById.get(id);
    entries.push(
      article
        ? {
            articleId: id,
            alreadyStored: true,
            article: {
              sourceId: article.sourceId,
              title: article.title,
              url: article.url,
              description: article.description,
              publishedAt: article.publishedAt?.toISOString() ?? null,
            },
          }
        : {
            articleId: id,
            alreadyStored: true,
            article: {
              sourceId: "",
              title: "Article supprimé",
              url: null,
              description: null,
              publishedAt: null,
            },
          },
    );
  }
  const rows = [
    [
      "Titre de l’article",
      "Source",
      "Type de source",
      "Lien de l’article",
      "Publication (UTC)",
      "Description",
      "Statut",
      "Motif / détail",
      "Pertinent",
      "Titre du résumé",
      "Résumé",
      "Points clés",
      "Pourquoi aucun résumé",
      "Dans le Daily Brief",
      "Déjà présent en base",
      "Origine",
      "Erreur de récupération",
      "Erreur IA",
      "Identifiant article",
      "Tentatives du job",
    ],
  ];
  for (const entry of entries) {
    const article = articleById.get(entry.articleId);
    const outcome = outcomeById.get(entry.articleId);
    const source = sourceById.get(entry.article.sourceId);
    const exclusion = input.exclusions.get(entry.articleId);
    let status: string;
    let reason: string;
    if (!article) {
      status = "Ignoré";
      reason = "L’article a été supprimé pendant l’exécution.";
    } else if (exclusion || outcome?.status === "skipped") {
      status = "Ignoré";
      reason =
        exclusion ??
        outcome?.skipReason ??
        article.relevanceReason ??
        "Article écarté pendant l’exécution.";
    } else if (outcome?.status === "failed") {
      status = "Échec";
      reason =
        outcome.failure?.message ??
        article.contentError ??
        article.summaryError ??
        "Le traitement de l’article a échoué.";
    } else if (article.relevant === false) {
      status = "Ignoré";
      reason = article.relevanceReason ?? "Article précédemment jugé non pertinent.";
    } else if (used.has(article.id)) {
      status = "Terminé";
      reason = article.relevanceReason ?? "Résumé réutilisé dans cette édition.";
    } else if (article.newsletters.length && !outcome) {
      status = "Ignoré";
      reason = "Article déjà associé à une newsletter envoyée ou dont l’envoi reste à vérifier.";
    } else if (source?.enabled === false) {
      status = "Ignoré";
      reason = "La source est désactivée.";
    } else if (outcome?.status === "completed" && article.summary && article.summarizedAt) {
      status = "Terminé";
      reason = article.relevanceReason ?? "Résumé disponible.";
    } else {
      status = "Non traité";
      reason = pending.has(entry.articleId)
        ? "Aucun résultat de traitement disponible pour cet article dans cette exécution."
        : "Article non traité pendant cette exécution.";
    }
    const summary =
      status === "Terminé" && article?.summary && article.summarizedAt ? article.summary : "";
    rows.push([
      entry.article.title,
      source?.url ?? "Source indisponible",
      source?.type ?? "",
      article?.contentUrl ?? entry.article.externalUrl ?? entry.article.url ?? "",
      entry.article.publishedAt ?? "",
      entry.article.description ?? "",
      status,
      reason,
      article?.relevant == null ? "Non évalué" : article.relevant ? "Oui" : "Non",
      summary ? (article?.summaryTitle ?? article?.title ?? "") : "",
      summary,
      summary ? (article?.keyPoints.join("\n") ?? "") : "",
      summary ? "" : reason,
      used.has(entry.articleId) ? "Oui" : "Non",
      entry.alreadyStored ? "Oui" : "Non",
      collectedIds.has(entry.articleId)
        ? "Récupéré pendant cette exécution"
        : pending.has(entry.articleId)
          ? "Repris depuis la base"
          : "Réutilisé pour le brief",
      article?.contentError ?? "",
      article?.summaryError ?? "",
      entry.articleId,
      outcome?.attempts === undefined ? "Non disponible" : String(outcome.attempts),
    ]);
  }
  return {
    runId: input.runId,
    date: input.date,
    tables: [
      { name: "Articles", rows },
      {
        name: "Sources",
        rows: [
          [
            "Source",
            "Type",
            "Statut",
            "Articles récupérés",
            "Durée (ms)",
            "Erreur",
            "Avertissements",
          ],
          ...input.sources.map((result) => [
            sourceById.get(result.sourceId)?.url ?? "Source supprimée",
            sourceById.get(result.sourceId)?.type ?? "",
            result.success ? "Terminée" : "Échec",
            String(result.articles.length),
            String(result.durationMs),
            result.error ?? "",
            result.warnings?.join("\n") ?? "",
          ]),
        ],
      },
      {
        name: "Exécution",
        rows: [
          ["Information", "Valeur"],
          ["Identifiant", input.runId],
          ["Date de l’édition", input.date],
          ["Fuseau horaire", input.timezone],
          ["Démarrage (UTC)", input.startedAt.toISOString()],
          ["Centres d’intérêt", input.interestPrompt],
          ["Articles récupérés", String(input.collected.length)],
          ["Articles utilisés dans le brief", String(used.size)],
          [
            "Périmètre",
            "Articles récupérés sur la période de collecte, articles repris et résumés réutilisés. Les dates écartées avant la collecte sont comptées dans les avertissements des sources.",
          ],
        ],
      },
    ],
  };
}
