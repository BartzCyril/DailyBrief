import type { Prisma } from "@prisma/client";
import type { Db } from "../db";
import type { CollectedArticle } from "../collection";
import type { ProgressObserver } from "../progress";
import { reportProgress } from "../progress";
import { JournalAccessService, journalAccessVersion, journalDomain } from "../journal-access";
import type { ArticleContentService } from "../article-content";
import { AppError } from "../errors";
import { logger } from "../logger";
import { failureFor } from "./failure";
import { ScrapingSummaryProcessor, type AuthenticatedPreparations } from "./scraping-summary";

type PendingArticle = Prisma.ArticleGetPayload<{ include: { source: true } }>;

// The collection job owns the browser. AI jobs in any process read the saved content,
// never cookies, passwords or a process-local session cache.
export async function prepareJournalContent(
  db: Db,
  userId: string,
  runId: string,
  pending: PendingArticle[],
  collected: CollectedArticle[],
  journals: JournalAccessService,
  content: ArticleContentService,
  processor: ScrapingSummaryProcessor,
  assertOwned: () => Promise<void>,
  observer?: ProgressObserver,
): Promise<AuthenticatedPreparations> {
  const credentials = await db.journalAccess.findMany({
    where: { userId, email: { not: null }, encryptedPassword: { not: null } },
  });
  if (!credentials.length) return {};
  const byDomain = new Map(credentials.map((access) => [access.domain, access]));
  const groups = new Map<string, Array<{ article: PendingArticle; externalUrl: string }>>();
  const prepared: AuthenticatedPreparations = {};
  for (const article of pending) {
    const selector = article.source.type === "RSS" ? article.source.articleLinkSelector : null;
    const current = collected.find(
      (item) =>
        item.sourceId === article.sourceId &&
        (article.guid ? item.guid === article.guid : item.url === article.url),
    );
    let url = article.url;
    if (selector) {
      if (current?.resolutionError) continue;
      try {
        url =
          current?.externalUrl ??
          (article.contentLinkSelector === selector ? article.contentUrl : null) ??
          (await content.resolveLink(article.url, selector));
      } catch {
        continue;
      }
    }
    if (!url) continue;
    let domain: string;
    try {
      domain = journalDomain(url);
    } catch {
      continue;
    }
    const access = byDomain.get(domain);
    if (!access) continue;
    const accessVersion = journalAccessVersion(access);
    const outcome = { articleId: article.id, status: "completed" as const, newSummary: false };
    prepared[article.id] = {
      outcome,
      accessVersion,
      sourceUpdatedAt: article.source.updatedAt.toISOString(),
    };
    if (!access.enabled) {
      prepared[article.id]!.outcome = { ...outcome, status: "skipped" };
      continue;
    }
    if (
      article.contentFetchedAt &&
      article.contentUrl === url &&
      article.contentLinkSelector === selector &&
      article.contentAccessVersion === accessVersion
    )
      continue;
    const group = groups.get(domain) ?? [];
    group.push({ article, externalUrl: url });
    groups.set(domain, group);
  }
  for (const [domain, articles] of groups) {
    await assertOwned();
    const remaining = new Set(articles.map(({ article }) => article.id));
    const notify = (message: string) =>
      reportProgress(observer, {
        stage: "content",
        status: "running",
        message: `${domain} : ${message}`,
      });
    logger.info(
      "journal.batch_started",
      "Préparation des articles avec une seule connexion au journal.",
      { userId, runId, domain, articles: articles.length },
    );
    try {
      await journals.withAuthenticatedSession(
        userId,
        domain,
        async (read) => {
          for (const { article, externalUrl } of articles) {
            await assertOwned();
            const outcome = await processor.run(
              userId,
              article.id,
              observer,
              {
                title: article.title,
                url: article.url,
                sourceId: article.sourceId,
                externalUrl,
                description: article.description,
                publishedAt: article.publishedAt?.toISOString() ?? null,
              },
              assertOwned,
              undefined,
              { contentOnly: true, authenticatedFetch: read },
            );
            prepared[article.id]!.outcome = outcome;
            remaining.delete(article.id);
          }
        },
        notify,
        prepared[articles[0]!.article.id]!.accessVersion,
      );
    } catch (error) {
      if (error instanceof AppError && ["LOCK_LOST", "COLLECTION_FINISHED"].includes(error.code))
        throw error;
      const failure = failureFor(error, "content");
      for (const { article } of articles) {
        if (!remaining.has(article.id)) continue;
        prepared[article.id]!.outcome = {
          articleId: article.id,
          status: failure.code === "JOURNAL_DISABLED" ? "skipped" : "failed",
          newSummary: false,
          ...(failure.code !== "JOURNAL_DISABLED" ? { failure } : {}),
        };
        await assertOwned();
        await db.article.updateMany({
          where: { id: article.id, userId },
          data: { contentError: failure.message },
        });
      }
      logger.error(
        "journal.batch_failed",
        "La session du journal n'a pas permis de préparer les articles.",
        { userId, runId, domain, error },
      );
    }
    logger.info(
      "journal.batch_finished",
      "Session du journal fermée après la préparation des articles.",
      { userId, runId, domain, articles: articles.length },
    );
  }
  return prepared;
}
