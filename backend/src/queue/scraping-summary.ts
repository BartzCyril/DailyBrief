import type { ArticleJobResult, CollectionStage } from "@dailybrief/shared";
import type { Db } from "../db";
import type { Source } from "@prisma/client";
import { analyzeArticle, type SummaryProvider } from "../ai";
import type { CollectedArticle } from "../collection";
import { ArticleContentService } from "../article-content";
import {
  JournalAccessService,
  journalAccessVersion,
  journalDomain,
  type AuthenticatedArticleReader,
} from "../journal-access";
import { AppError } from "../errors";
import { reportProgress, type ProgressObserver } from "../progress";
import { failureFor } from "./failure";
import { getSettings } from "../collection";
import { DailyBriefService } from "../daily-brief";

export type AuthenticatedPreparation = {
  outcome: ArticleJobResult;
  accessVersion: string;
  sourceUpdatedAt: string;
};
export type AuthenticatedPreparations = Record<string, AuthenticatedPreparation>;
type ProcessingOptions = {
  contentOnly?: boolean;
  authenticatedFetch?: AuthenticatedArticleReader;
  authenticatedPreparation?: AuthenticatedPreparation;
  requirePreparedAuthentication?: boolean;
};

// Redis contains only identifiers; article bodies and credentials are read server-side.
export class ScrapingSummaryProcessor {
  constructor(
    private db: Db,
    private summary: SummaryProvider,
    private articleContent = new ArticleContentService(),
    private journals = new JournalAccessService(db, articleContent),
  ) {}
  async brief(
    userId: string,
    runId: string,
    observer?: ProgressObserver,
    assertOwned?: () => Promise<void>,
  ) {
    return new DailyBriefService(this.db, this.summary, this.journals).run(
      userId,
      runId,
      observer,
      assertOwned,
    );
  }

  async run(
    userId: string,
    articleId: string,
    observer?: ProgressObserver,
    collected?: CollectedArticle,
    assertOwned: () => Promise<void> = async () => {},
    interestPrompt?: string,
    options: ProcessingOptions = {},
  ): Promise<ArticleJobResult> {
    let article = await this.db.article.findFirst({
      where: { id: articleId, userId },
      include: { source: true },
    });
    const outcome: ArticleJobResult = { articleId, status: "completed", newSummary: false };
    if (!article) return { ...outcome, status: "skipped", skipReason: "L’article a été supprimé." };
    if (!article.source.enabled)
      return { ...outcome, status: "skipped", skipReason: "La source est désactivée." };
    if (article.relevant === false)
      return {
        ...outcome,
        status: "skipped",
        skipReason: article.relevanceReason ?? "Article précédemment écarté par l’IA.",
      };
    const delivery = await this.db.newsletterArticle.findFirst({
      where: { articleId, newsletter: { status: { in: ["SENT", "SENDING"] } } },
      select: { newsletter: { select: { status: true } } },
    });
    if (delivery)
      return {
        ...outcome,
        status: "skipped",
        skipReason:
          delivery.newsletter.status === "SENT"
            ? "Cet article a déjà été traité dans une newsletter envoyée."
            : "Cet article figure dans une newsletter dont l’envoi est en cours ou reste à vérifier.",
      };
    const prepared = options.authenticatedPreparation;
    if (prepared && prepared.sourceUpdatedAt !== article.source.updatedAt.toISOString())
      return {
        ...outcome,
        status: "failed",
        failure: failureFor(
          new AppError(409, "La source a changé. Relancez la récupération.", "SOURCE_CHANGED"),
          "content",
        ),
      };
    if (prepared && prepared.outcome.status !== "completed") return prepared.outcome;
    const sourceVersion = (source: Source) =>
      JSON.stringify([source.type, source.url, source.articleLinkSelector, source.scrapingConfig]);
    const expectedSourceVersion = sourceVersion(article.source);
    const assertCurrent = async () => {
      await assertOwned();
      const current = await this.db.source.findFirst({ where: { id: article!.sourceId, userId } });
      if (!current?.enabled || sourceVersion(current) !== expectedSourceVersion)
        throw new AppError(409, "La source a changé. Relancez la récupération.", "SOURCE_CHANGED");
      if (
        externalUrl &&
        journalAccessVersion(await this.journals.assertAccessible(userId, externalUrl)) !==
          article!.contentAccessVersion
      )
        throw new AppError(
          409,
          "L'accès au journal a changé. Relancez la récupération.",
          "JOURNAL_ACCESS_CHANGED",
        );
    };
    let processed = 0;
    const report = (progress: Parameters<typeof reportProgress>[1]) =>
      reportProgress(observer, progress);
    let stage: CollectionStage = "content";
    const articleLinkSelector =
      article.source.type === "RSS" ? article.source.articleLinkSelector : null;
    let externalUrl: string | undefined;
    let accessVersion: string | null = null;
    // Access can be configured after the producer's snapshot. Never let a summary
    // consumer start its own authenticated browser when preparation is missing.
    let directAuthenticationConfigured = false;
    if (options.requirePreparedAuthentication && !articleLinkSelector && !prepared && article.url) {
      let domain: string | undefined;
      try {
        domain = journalDomain(article.url);
      } catch {
        /* Invalid article URLs are handled by the content loader. */
      }
      if (domain) {
        const access = await this.db.journalAccess.findUnique({
          where: { userId_domain: { userId, domain } },
        });
        directAuthenticationConfigured = Boolean(access?.encryptedPassword);
      }
    }
    if (
      articleLinkSelector ||
      options.authenticatedFetch ||
      prepared ||
      directAuthenticationConfigured
    ) {
      try {
        if (collected?.resolutionError)
          throw new AppError(422, collected.resolutionError, "ARTICLE_LINK_UNRESOLVED");
        externalUrl = prepared
          ? (article.contentUrl ?? undefined)
          : (collected?.externalUrl ??
            (articleLinkSelector
              ? await this.articleContent.resolveLink(article.url, articleLinkSelector)
              : (article.url ?? undefined)));
        if (!externalUrl)
          throw new AppError(
            409,
            "Le contenu authentifié préparé est indisponible. Relancez la récupération.",
            "JOURNAL_PREPARATION_INVALID",
          );
        const access = await this.journals.assertAccessible(userId, externalUrl);
        if (
          options.requirePreparedAuthentication &&
          access.encryptedPassword &&
          !prepared &&
          !options.authenticatedFetch
        )
          throw new AppError(
            409,
            "L'accès authentifié n'a pas été préparé. Relancez la récupération.",
            "JOURNAL_PREPARATION_INVALID",
          );
        accessVersion = journalAccessVersion(access);
        if (prepared && accessVersion !== prepared.accessVersion)
          throw new AppError(
            409,
            "L'accès au journal a changé. Relancez la récupération.",
            "JOURNAL_ACCESS_CHANGED",
          );
      } catch (error) {
        processed++;
        const failure = failureFor(error, "content");
        if (failure.code !== "JOURNAL_DISABLED") outcome.failure = failure;
        report({
          stage: "content",
          status: failure.code === "JOURNAL_DISABLED" ? "skipped" : "failed",
          message: `${article.title} : ${failure.message}`,
        });
        outcome.status = failure.code === "JOURNAL_DISABLED" ? "skipped" : "failed";
        if (outcome.status === "skipped") outcome.skipReason = failure.message;
        return outcome;
      }
    }
    if (
      !article.contentFetchedAt ||
      article.contentLinkSelector !== articleLinkSelector ||
      (externalUrl && article.contentAccessVersion !== accessVersion) ||
      (externalUrl && article.contentUrl !== externalUrl)
    ) {
      report({
        stage,
        status: "running",
        message: `Téléchargement de la page complète : ${article.title}`,
        completed: processed,
        total: 1,
      });
      try {
        if (prepared)
          throw new AppError(
            409,
            "Le contenu authentifié préparé est indisponible. Relancez la récupération.",
            "JOURNAL_PREPARATION_INVALID",
          );
        const contentProgress = (message: string) =>
          report({
            stage: "content",
            status: "running",
            message: `${article!.title} : ${message}`,
            completed: processed,
            total: 1,
          });
        const fetched = externalUrl
          ? await (
              options.authenticatedFetch ??
              ((url, notify) => this.journals.fetchArticle(userId, url, notify))
            )(externalUrl, contentProgress)
          : await this.articleContent.fetchWithUrl(
              article.url,
              contentProgress,
              articleLinkSelector,
            );
        const { content, url } = fetched;
        await assertOwned();
        article = {
          ...article,
          ...(await this.db.article.update({
            where: { id: article.id },
            data: {
              content,
              contentFetchedAt: new Date(),
              contentUrl: url,
              contentLinkSelector: articleLinkSelector,
              contentAccessVersion:
                "accessVersion" in fetched ? (fetched.accessVersion as string) : null,
              contentError: null,
              // Old summaries based on feed excerpts must be regenerated before delivery.
              summaryTitle: null,
              summary: null,
              keyPoints: [],
              summarizedAt: null,
              summaryError: null,
              relevant: null,
              relevanceReason: null,
              analyzedAt: null,
            },
          })),
        };
        report({
          stage,
          status: "completed",
          message: `Texte de l'article extrait et sauvegardé : ${article.title} (${content.length} caractères).`,
          completed: processed,
          total: 1,
        });
      } catch (error) {
        if (error instanceof AppError && ["LOCK_LOST", "COLLECTION_FINISHED"].includes(error.code))
          throw error;
        const failure = failureFor(error, stage);
        if (failure.code !== "JOURNAL_DISABLED") outcome.failure = failure;
        await this.db.article.update({
          where: { id: article.id },
          data: { contentError: failure.message },
        });
        processed++;
        report({
          stage,
          status: "failed",
          message: `${article.title} : ${failure.message}`,
          completed: processed,
          total: 1,
        });
        outcome.status = failure.code === "JOURNAL_DISABLED" ? "skipped" : "failed";
        if (outcome.status === "skipped") outcome.skipReason = failure.message;
        return outcome;
      }
    } else {
      report({
        stage,
        status: "skipped",
        message: `Texte complet déjà sauvegardé : ${article.title}`,
        completed: processed,
        total: 1,
      });
    }
    if (externalUrl) {
      try {
        const currentAccess = await this.journals.assertAccessible(userId, externalUrl);
        if (journalAccessVersion(currentAccess) !== article.contentAccessVersion)
          throw new AppError(
            409,
            "L'accès au journal a changé. Relancez la récupération.",
            "JOURNAL_ACCESS_CHANGED",
          );
      } catch (error) {
        processed++;
        const failure = failureFor(error, "content");
        if (failure.code !== "JOURNAL_DISABLED") outcome.failure = failure;
        report({
          stage: "content",
          status: failure.code === "JOURNAL_DISABLED" ? "skipped" : "failed",
          message: `${article.title} : ${failure.message}`,
        });
        outcome.status = failure.code === "JOURNAL_DISABLED" ? "skipped" : "failed";
        if (outcome.status === "skipped") outcome.skipReason = failure.message;
        return outcome;
      }
    }
    if (options.contentOnly) {
      await assertCurrent();
      return outcome;
    }
    stage = "ai";
    if (!article.summary || !article.summarizedAt || !article.analyzedAt) {
      report({
        stage,
        status: "running",
        message: `Analyse de pertinence et résumé : ${article.title}`,
        completed: processed,
        total: 1,
      });
      try {
        await assertCurrent();
        const input = {
          title: article.title,
          content: article.content!,
          url: article.contentUrl ?? article.url,
        };
        const notify = (message: string) =>
          report({
            stage: "ai",
            status: "running",
            message: `${article!.title} : ${message}`,
            completed: processed,
            total: 1,
          });
        const prompt = interestPrompt ?? (await getSettings(this.db, userId)).interestPrompt;
        const analysis = await analyzeArticle(
          this.summary,
          { ...input, description: article.description, interestPrompt: prompt },
          notify,
        );
        await assertCurrent();
        if (!analysis.relevant) {
          await this.db.article.update({
            where: { id: article.id },
            data: {
              relevant: false,
              relevanceReason: analysis.reason,
              analyzedAt: new Date(),
              summaryTitle: null,
              summary: null,
              keyPoints: [],
              summarizedAt: null,
              summaryError: null,
            },
          });
          report({
            stage,
            status: "skipped",
            message: `Article non pertinent : ${article.title}. ${analysis.reason}`,
            completed: processed + 1,
            total: 1,
          });
          return { ...outcome, status: "skipped", skipReason: analysis.reason };
        }
        const summary = analysis.summary;
        article = {
          ...article,
          ...(await this.db.article.update({
            where: { id: article.id },
            data: {
              summaryTitle: summary.title,
              summary: summary.summary,
              keyPoints: summary.keyPoints,
              summarizedAt: new Date(),
              summaryError: null,
              relevant: true,
              relevanceReason: analysis.reason,
              analyzedAt: new Date(),
            },
          })),
        };
        outcome.newSummary = true;
        report({
          stage,
          status: "completed",
          message: `Résumé enregistré : ${article.title}`,
          completed: processed + 1,
          total: 1,
        });
      } catch (error) {
        if (error instanceof AppError && ["LOCK_LOST", "COLLECTION_FINISHED"].includes(error.code))
          throw error;
        const failure = failureFor(error, "ai");
        if (failure.code !== "JOURNAL_DISABLED") outcome.failure = failure;
        await this.db.article.update({
          where: { id: article.id },
          data: {
            summaryError: failure.message,
          },
        });
        processed++;
        report({
          stage,
          status: "failed",
          message: `${article.title} : ${failure.message}`,
          completed: processed,
          total: 1,
        });
        outcome.status = failure.code === "JOURNAL_DISABLED" ? "skipped" : "failed";
        if (outcome.status === "skipped") outcome.skipReason = failure.message;
        return outcome;
      }
    } else {
      report({
        stage,
        status: "skipped",
        message: `Résumé déjà disponible : ${article.title}`,
        completed: processed + 1,
        total: 1,
      });
    }

    return outcome;
  }
}
