import type { ArticleJobResult, CollectionStage } from "@dailybrief/shared";
import type { Db } from "../db";
import type { Source } from "@prisma/client";
import type { SummaryProvider } from "../ai";
import type { CollectedArticle } from "../collection";
import { ArticleContentService } from "../article-content";
import { JournalAccessService, journalAccessVersion } from "../journal-access";
import { AppError } from "../errors";
import { reportProgress, type ProgressObserver } from "../progress";
import { failureFor } from "./failure";

// Redis contains only identifiers; article bodies and credentials are read server-side.
export class ScrapingSummaryProcessor {
  constructor(
    private db: Db,
    private summary: SummaryProvider,
    private articleContent = new ArticleContentService(),
    private journals = new JournalAccessService(db, articleContent),
  ) {}

  async run(
    userId: string,
    articleId: string,
    observer?: ProgressObserver,
    collected?: CollectedArticle,
    assertOwned: () => Promise<void> = async () => {},
  ): Promise<ArticleJobResult> {
    let article = await this.db.article.findFirst({
      where: { id: articleId, userId },
      include: { source: true },
    });
    const outcome: ArticleJobResult = { articleId, status: "completed", newSummary: false };
    if (
      !article ||
      !article.source.enabled ||
      (await this.db.newsletterArticle.findFirst({
        where: { articleId, newsletter: { status: { in: ["SENT", "SENDING"] } } },
      }))
    )
      return { ...outcome, status: "skipped" };
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
    if (articleLinkSelector) {
      try {
        if (collected?.resolutionError)
          throw new AppError(422, collected.resolutionError, "ARTICLE_LINK_UNRESOLVED");
        externalUrl =
          collected?.externalUrl ??
          (await this.articleContent.resolveLink(article.url, articleLinkSelector));
        accessVersion = journalAccessVersion(
          await this.journals.assertAccessible(userId, externalUrl),
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
        const contentProgress = (message: string) =>
          report({
            stage: "content",
            status: "running",
            message: `${article!.title} : ${message}`,
            completed: processed,
            total: 1,
          });
        const fetched = externalUrl
          ? await this.journals.fetchArticle(userId, externalUrl, contentProgress)
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
        return outcome;
      }
    }
    stage = "ai";
    if (!article.summary || !article.summarizedAt) {
      report({
        stage,
        status: "running",
        message: `Envoi à l'IA : ${article.title}`,
        completed: processed,
        total: 1,
      });
      try {
        await assertCurrent();
        const summary = await this.summary.summarize(
          {
            title: article.title,
            content: article.content!,
            url: article.contentUrl ?? article.url,
          },
          (message) =>
            report({
              stage: "ai",
              status: "running",
              message: `${article!.title} : ${message}`,
              completed: processed,
              total: 1,
            }),
        );
        await assertCurrent();
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
