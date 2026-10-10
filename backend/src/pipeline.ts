import { Prisma } from "@prisma/client";
import type { Db } from "./db";
import {
  SourceCollector,
  getSettings,
  type CollectedArticle,
  type CollectionRunner,
  type RunTrigger,
} from "./collection";
import { UserCollectionLock } from "./lock";
import type { SummaryProvider } from "./ai";
import type { NewsletterSender } from "./email";
import { renderNewsletter } from "./newsletter-template";
import { articleIdentity } from "./fingerprint";
import { nextCollection } from "./schedule";
import { AppError } from "./errors";
import type { CollectionFailure, CollectionStage, RunResult } from "@dailybrief/shared";
import { reportProgress, type ProgressObserver } from "./progress";
import { ArticleContentService } from "./article-content";
import { JournalAccessService, journalAccessVersion } from "./journal-access";
import { failureFor } from "./queue/failure";
import { ScrapingSummaryProcessor } from "./queue/scraping-summary";
import type { ArticleJobResult } from "@dailybrief/shared";
export type ArticleDispatcher = (
  userId: string,
  runId: string,
  articleIds: string[],
  observer?: ProgressObserver,
) => Promise<ArticleJobResult[]>;
export type DailyBriefRunResult = RunResult;

export class DailyBriefPipelineService implements CollectionRunner {
  constructor(
    private db: Db,
    private collector: SourceCollector,
    private lock: UserCollectionLock,
    private summary: SummaryProvider,
    private email: NewsletterSender,
    private articleContent = new ArticleContentService(),
    private journals = new JournalAccessService(db, articleContent),
    private dispatch?: ArticleDispatcher,
  ) {}
  private async persist(userId: string, article: CollectedArticle): Promise<boolean> {
    const identity = articleIdentity(article);
    const where: Prisma.ArticleWhereInput = {
      userId,
      OR: [
        { fingerprint: identity.fingerprint },
        { contentHash: identity.contentHash },
        ...(identity.canonicalUrl ? [{ canonicalUrl: identity.canonicalUrl }] : []),
        ...(identity.guid ? [{ sourceId: article.sourceId, guid: identity.guid }] : []),
      ],
    };
    if (await this.db.article.findFirst({ where })) return false;
    try {
      await this.db.article.create({
        data: {
          userId,
          sourceId: article.sourceId,
          title: article.title,
          url: article.url,
          content: article.content,
          description: article.description,
          contentUrl: article.externalUrl ?? null,
          publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
          ...identity,
        },
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        (await this.db.article.findFirst({ where }))
      )
        return false;
      throw error;
    }
  }
  private async finish(runId: string, userId: string, trigger: RunTrigger, result: RunResult) {
    const now = new Date();
    const currentSettings = await getSettings(this.db, userId);
    const { newsletterId, failure, ...runData } = result;
    await this.db.$transaction([
      this.db.dailyBriefRun.update({
        where: { id: runId },
        data: {
          ...runData,
          ...(newsletterId ? { newsletterId } : {}),
          error: failure?.message ?? null,
          finishedAt: now,
        },
      }),
      this.db.dailyBriefSettings.update({
        where: { userId },
        data: {
          lastCollectionAt: now,
          ...(trigger === "scheduled"
            ? {
                nextCollectionAt: currentSettings.collectionEnabled
                  ? nextCollection(currentSettings.collectionTime, currentSettings.timezone, now)
                  : null,
              }
            : {}),
        },
      }),
    ]);
  }
  async run(
    userId: string,
    trigger: RunTrigger = "manual",
    observer?: ProgressObserver,
    queuedRunId?: string,
  ): Promise<DailyBriefRunResult> {
    return this.lock.run(userId, async (assertOwned) => {
      const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
      const settings = await getSettings(this.db, userId);
      const previous = queuedRunId
        ? await this.db.dailyBriefRun.findFirstOrThrow({ where: { id: queuedRunId, userId } })
        : null;
      const restored = (): RunResult => ({
        status: previous!.status as RunResult["status"],
        sourcesProcessed: previous!.sourcesProcessed,
        sourcesFailed: previous!.sourcesFailed,
        articlesCollected: previous!.articlesCollected,
        newArticles: previous!.newArticles,
        articlesSummarized: previous!.articlesSummarized,
        emailSent: previous!.emailSent,
        ...(previous!.newsletterId ? { newsletterId: previous!.newsletterId } : {}),
        ...(previous!.error
          ? {
              failure: { stage: "collection", code: "COLLECTION_FAILED", message: previous!.error },
            }
          : {}),
      });
      if (previous?.finishedAt) return restored();
      // A worker may stop after SMTP accepted the email but before finishing the root job.
      if (previous?.newsletterId) {
        const delivery = await this.db.newsletter.findFirst({
          where: { id: previous.newsletterId, userId },
        });
        if (delivery?.status === "SENT" || delivery?.status === "SENDING") {
          const sent = delivery.status === "SENT";
          const error = sent
            ? null
            : "L'envoi précédent est incertain. Vérifiez sa réception avant toute nouvelle tentative.";
          const recovered: RunResult = {
            ...restored(),
            status: sent ? "SENT" : "FAILED",
            emailSent: sent,
            ...(error
              ? { failure: { stage: "email", code: "SMTP_UNCERTAIN", message: error } }
              : {}),
          };
          await this.finish(previous.id, userId, trigger, recovered);
          return recovered;
        }
      }
      if (
        trigger === "scheduled" &&
        (!settings.collectionEnabled ||
          !settings.nextCollectionAt ||
          settings.nextCollectionAt > new Date())
      ) {
        if (previous)
          await this.db.dailyBriefRun.update({
            where: { id: previous.id },
            data: { status: "NO_NEW_ARTICLES", finishedAt: new Date() },
          });
        return {
          status: "NO_NEW_ARTICLES",
          sourcesProcessed: 0,
          sourcesFailed: 0,
          articlesCollected: 0,
          newArticles: 0,
          articlesSummarized: 0,
          emailSent: false,
        };
      }
      const run = previous
        ? await this.db.dailyBriefRun.update({
            where: { id: previous.id },
            data: { status: "RUNNING" },
          })
        : await this.db.dailyBriefRun.create({ data: { userId, trigger } });
      const result: DailyBriefRunResult = {
        status: "FAILED",
        sourcesProcessed: 0,
        sourcesFailed: 0,
        articlesCollected: 0,
        newArticles: 0,
        articlesSummarized: 0,
        emailSent: false,
      };
      let newsletterId: string | undefined;
      let accepted = false;
      let stage: CollectionStage = "collection";
      const report = (progress: Parameters<typeof reportProgress>[1]) =>
        reportProgress(observer, progress);
      try {
        report({
          stage,
          status: "running",
          message: "Démarrage de la collecte des sources actives.",
        });
        const sources = await this.collector.collect(userId, observer);
        result.sourcesProcessed = sources.length;
        result.sourcesFailed = sources.filter((source) => !source.success).length;
        const articles = sources.flatMap((source) => source.articles);
        result.articlesCollected = articles.length;
        report({
          stage,
          status: "completed",
          message: `${articles.length} articles récupérés ; ${result.sourcesFailed} sources en échec.`,
        });
        await this.db.dailyBriefRun.update({
          where: { id: run.id },
          data: {
            sourceResults: sources.map(({ articles, ...source }) => ({
              ...source,
              articlesCollected: articles.length,
            })),
          },
        });
        stage = "storage";
        report({
          stage,
          status: "running",
          message: "Détection des doublons et sauvegarde des articles.",
        });
        let newArticles = 0;
        for (const article of articles) if (await this.persist(userId, article)) newArticles++;
        result.newArticles = (previous?.newArticles ?? 0) + newArticles;
        report({
          stage,
          status: "completed",
          message: `${newArticles} nouveaux articles sauvegardés ; ${articles.length - newArticles} doublons ignorés.`,
        });
        await this.db.dailyBriefRun.update({
          where: { id: run.id },
          data: {
            sourcesProcessed: result.sourcesProcessed,
            sourcesFailed: result.sourcesFailed,
            articlesCollected: result.articlesCollected,
            newArticles: result.newArticles,
          },
        });
        const pending = await this.db.article.findMany({
          where: {
            userId,
            source: { enabled: true },
            newsletters: { none: { newsletter: { status: { in: ["SENT", "SENDING"] } } } },
          },
          include: { source: true },
          orderBy: { createdAt: "asc" },
        });
        const included: typeof pending = [];
        let summaryFailure: CollectionFailure | undefined;
        const processor = new ScrapingSummaryProcessor(
          this.db,
          this.summary,
          this.articleContent,
          this.journals,
        );
        let outcomes: ArticleJobResult[];
        if (this.dispatch) {
          stage = "ai";
          outcomes = await this.dispatch(
            userId,
            run.id,
            pending.map((article) => article.id),
            observer,
          );
        } else {
          outcomes = [];
          for (const article of pending) {
            const collected = articles.find(
              (item) =>
                item.sourceId === article.sourceId &&
                (article.guid ? item.guid === article.guid : item.url === article.url),
            );
            const outcome = await processor.run(
              userId,
              article.id,
              observer,
              collected,
              assertOwned,
            );
            outcomes.push(outcome);
            if (
              outcome.failure &&
              ["MODEL_MISSING", "AI_UNAVAILABLE"].includes(outcome.failure.code)
            )
              break;
          }
        }
        for (const outcome of outcomes) {
          if (outcome.newSummary) result.articlesSummarized++;
          summaryFailure ??= outcome.failure;
          if (outcome.status === "completed") {
            const article = await this.db.article.findFirst({
              where: { id: outcome.articleId, userId, source: { enabled: true } },
              include: { source: true },
            });
            if (article?.summary && article.summarizedAt) included.push(article);
          }
        }
        if (this.dispatch)
          result.articlesSummarized = await this.db.article.count({
            where: {
              userId,
              id: { in: outcomes.map((outcome) => outcome.articleId) },
              summarizedAt: { gte: run.startedAt },
            },
          });
        // Recheck persisted settings after potentially long downloads/AI calls.
        for (let index = included.length - 1; index >= 0; index--) {
          const article = included[index]!;
          const source = await this.db.source.findFirst({
            where: { id: article.sourceId, userId, enabled: true },
          });
          if (!source) {
            included.splice(index, 1);
            report({
              stage: "newsletter",
              status: "skipped",
              message: `${article.title} : source désactivée ou supprimée.`,
            });
            continue;
          }
          if (source.type === "RSS" && source.articleLinkSelector !== article.contentLinkSelector) {
            included.splice(index, 1);
            summaryFailure ??= {
              stage: "content",
              code: "SOURCE_CHANGED",
              message: "La source a changé. Relancez la récupération.",
            };
            continue;
          }
          if (
            article.source.type !== "RSS" ||
            !article.source.articleLinkSelector ||
            !article.contentUrl
          )
            continue;
          try {
            const currentAccess = await this.journals.assertAccessible(userId, article.contentUrl);
            if (journalAccessVersion(currentAccess) !== article.contentAccessVersion)
              throw new AppError(
                409,
                "L'accès au journal a changé. Relancez la récupération.",
                "JOURNAL_ACCESS_CHANGED",
              );
          } catch (error) {
            included.splice(index, 1);
            const failure = failureFor(error, "content");
            if (failure.code !== "JOURNAL_DISABLED") summaryFailure ??= failure;
            report({
              stage: "newsletter",
              status: "skipped",
              message: `${article.title} : ${failure.message}`,
            });
          }
        }
        if (!included.length) {
          result.status = summaryFailure || result.sourcesFailed ? "FAILED" : "NO_NEW_ARTICLES";
          if (result.status === "FAILED") {
            result.failure = summaryFailure ?? {
              stage: "source",
              code: "SOURCE_COLLECTION_FAILED",
              message:
                sources.find((source) => !source.success)?.error ??
                "La récupération des sources a échoué.",
            };
          }
          report({
            stage: "newsletter",
            status: result.status === "FAILED" ? "failed" : "skipped",
            message: result.failure?.message ?? "Aucun nouvel article à envoyer.",
          });
          return result;
        }
        stage = "newsletter";
        report({
          stage,
          status: "running",
          message: `Préparation de la newsletter avec ${included.length} articles.`,
        });
        const rendered = renderNewsletter(
          included.map((article) => ({
            title: article.summaryTitle ?? article.title,
            summary: article.summary!,
            keyPoints: article.keyPoints,
            url: article.contentUrl ?? article.url,
            source: `${article.source.type} · ${new URL(article.source.url).hostname}`,
            publishedAt: article.publishedAt,
          })),
          settings.timezone,
        );
        const newsletter = await this.db.newsletter.create({
          data: {
            userId,
            recipientEmail: user.email,
            subject: rendered.subject,
            status: "READY",
            articles: { create: included.map((article) => ({ articleId: article.id })) },
          },
        });
        newsletterId = newsletter.id;
        result.newsletterId = newsletterId;
        await this.db.dailyBriefRun.update({
          where: { id: run.id },
          data: {
            newsletterId,
            sourcesProcessed: result.sourcesProcessed,
            sourcesFailed: result.sourcesFailed,
            articlesCollected: result.articlesCollected,
            newArticles: result.newArticles,
            articlesSummarized: result.articlesSummarized,
          },
        });
        report({ stage, status: "completed", message: "Newsletter préparée et sauvegardée." });
        await assertOwned();
        stage = "email";
        await this.db.newsletter.update({
          where: { id: newsletterId },
          data: { status: "SENDING" },
        });
        report({ stage, status: "running", message: "Envoi de la newsletter au serveur mail." });
        await this.email.send({ ...rendered, to: user.email, newsletterId });
        accepted = true;
        await this.db.newsletter.update({
          where: { id: newsletterId },
          data: { status: "SENT", sentAt: new Date() },
        });
        result.status = "SENT";
        result.emailSent = true;
        report({ stage, status: "completed", message: "Newsletter acceptée par le serveur mail." });
        return result;
      } catch (error) {
        result.failure = failureFor(error, stage);
        report({ stage, status: "failed", message: result.failure.message });
        if (
          newsletterId &&
          !accepted &&
          !(error instanceof AppError && error.code === "SMTP_UNCERTAIN")
        )
          await this.db.newsletter.update({
            where: { id: newsletterId },
            data: { status: "FAILED", error: result.failure.message },
          });
        return result;
      } finally {
        // A stalled worker must not overwrite the run now owned by its replacement.
        if (queuedRunId) await assertOwned();
        await this.finish(run.id, userId, trigger, result);
      }
    });
  }
}
