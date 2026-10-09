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
import { JournalAccessService, journalDomain } from "./journal-access";
export type DailyBriefRunResult = RunResult;

function failureFor(error: unknown, stage: CollectionStage): CollectionFailure {
  const fallback =
    stage === "ai"
      ? "Échec du résumé IA."
      : stage === "email"
        ? "L'envoi SMTP a échoué. Vérifiez la configuration du serveur mail."
        : stage === "content"
          ? "La récupération du contenu complet de l'article a échoué."
          : "Échec du pipeline DailyBrief.";
  return {
    stage,
    code: error instanceof AppError ? error.code : "PIPELINE_FAILED",
    message: error instanceof AppError ? error.message : fallback,
  };
}
export class DailyBriefPipelineService implements CollectionRunner {
  constructor(
    private db: Db,
    private collector: SourceCollector,
    private lock: UserCollectionLock,
    private summary: SummaryProvider,
    private email: NewsletterSender,
    private articleContent = new ArticleContentService(),
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
  async run(
    userId: string,
    trigger: RunTrigger = "manual",
    observer?: ProgressObserver,
  ): Promise<DailyBriefRunResult> {
    return this.lock.run(userId, async (assertOwned) => {
      const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
      const settings = await getSettings(this.db, userId);
      if (
        trigger === "scheduled" &&
        (!settings.collectionEnabled ||
          !settings.nextCollectionAt ||
          settings.nextCollectionAt > new Date())
      )
        return {
          status: "NO_NEW_ARTICLES",
          sourcesProcessed: 0,
          sourcesFailed: 0,
          articlesCollected: 0,
          newArticles: 0,
          articlesSummarized: 0,
          emailSent: false,
        };
      const run = await this.db.dailyBriefRun.create({ data: { userId } });
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
        for (const article of articles)
          if (await this.persist(userId, article)) result.newArticles++;
        report({
          stage,
          status: "completed",
          message: `${result.newArticles} nouveaux articles sauvegardés ; ${articles.length - result.newArticles} doublons ignorés.`,
        });
        const pending = await this.db.article.findMany({
          where: {
            userId,
            source: { enabled: true },
            newsletters: { none: { newsletter: { status: { in: ["SENT", "SENDING"] } } } },
          },
          include: { source: true },
          orderBy: { createdAt: "asc" },
          // Disabled selector journals must not fill the delivery batch and starve active ones.
          take: (await this.db.source.count({
            where: { userId, enabled: true, type: "RSS", articleLinkSelector: { not: null } },
          }))
            ? undefined
            : 100,
        });
        const included: typeof pending = [];
        let summaryFailure: CollectionFailure | undefined;
        let processed = 0;
        let eligible = 0;
        for (let article of pending) {
          stage = "content";
          const articleLinkSelector =
            article.source.type === "RSS" ? article.source.articleLinkSelector : null;
          let externalUrl: string | undefined;
          if (articleLinkSelector) {
            try {
              const collected = articles.find(
                (item) =>
                  item.sourceId === article.sourceId &&
                  (article.guid ? item.guid === article.guid : item.url === article.url),
              );
              if (collected?.resolutionError)
                throw new AppError(422, collected.resolutionError, "ARTICLE_LINK_UNRESOLVED");
              externalUrl =
                collected?.externalUrl ??
                (await this.articleContent.resolveLink(article.url, articleLinkSelector));
              await new JournalAccessService(this.db, this.articleContent).assertAccessible(
                userId,
                externalUrl,
              );
            } catch (error) {
              processed++;
              const failure = failureFor(error, "content");
              if (failure.code !== "JOURNAL_DISABLED") summaryFailure ??= failure;
              report({
                stage: "content",
                status: failure.code === "JOURNAL_DISABLED" ? "skipped" : "failed",
                message: `${article.title} : ${failure.message}`,
              });
              continue;
            }
          }
          if (++eligible > 100) break;
          if (
            !article.contentFetchedAt ||
            article.contentLinkSelector !== articleLinkSelector ||
            (externalUrl && article.contentUrl !== externalUrl)
          ) {
            report({
              stage,
              status: "running",
              message: `Téléchargement de la page complète : ${article.title}`,
              completed: processed,
              total: pending.length,
            });
            try {
              const { content, url } = await this.articleContent.fetchWithUrl(
                externalUrl ?? article.url,
                (message) =>
                  report({
                    stage: "content",
                    status: "running",
                    message: `${article.title} : ${message}`,
                    completed: processed,
                    total: pending.length,
                  }),
                externalUrl ? null : articleLinkSelector,
                externalUrl ? journalDomain(externalUrl) : undefined,
              );
              article = {
                ...article,
                ...(await this.db.article.update({
                  where: { id: article.id },
                  data: {
                    content,
                    contentFetchedAt: new Date(),
                    contentUrl: url,
                    contentLinkSelector: articleLinkSelector,
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
                total: pending.length,
              });
            } catch (error) {
              const failure = failureFor(error, stage);
              summaryFailure ??= failure;
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
                total: pending.length,
              });
              continue;
            }
          } else {
            report({
              stage,
              status: "skipped",
              message: `Texte complet déjà sauvegardé : ${article.title}`,
              completed: processed,
              total: pending.length,
            });
          }
          if (externalUrl) {
            try {
              await new JournalAccessService(this.db, this.articleContent).assertAccessible(
                userId,
                externalUrl,
              );
            } catch (error) {
              processed++;
              const failure = failureFor(error, "content");
              if (failure.code !== "JOURNAL_DISABLED") summaryFailure ??= failure;
              report({
                stage: "content",
                status: failure.code === "JOURNAL_DISABLED" ? "skipped" : "failed",
                message: `${article.title} : ${failure.message}`,
              });
              continue;
            }
          }
          stage = "ai";
          if (!article.summary || !article.summarizedAt) {
            report({
              stage,
              status: "running",
              message: `Envoi à l'IA : ${article.title}`,
              completed: processed,
              total: pending.length,
            });
            try {
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
                    message: `${article.title} : ${message}`,
                    completed: processed,
                    total: pending.length,
                  }),
              );
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
              result.articlesSummarized++;
              report({
                stage,
                status: "completed",
                message: `Résumé enregistré : ${article.title}`,
                completed: processed + 1,
                total: pending.length,
              });
            } catch (error) {
              const failure = failureFor(error, "ai");
              summaryFailure ??= failure;
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
                total: pending.length,
              });
              // Infrastructure failures affect every article; retain all pending articles for retry.
              if (["MODEL_MISSING", "AI_UNAVAILABLE"].includes(failure.code)) {
                report({
                  stage,
                  status: "skipped",
                  message: "Résumés restants suspendus jusqu'au rétablissement du service IA.",
                  completed: processed,
                  total: pending.length,
                });
                break;
              }
              continue;
            }
          } else {
            report({
              stage,
              status: "skipped",
              message: `Résumé déjà disponible : ${article.title}`,
              completed: processed + 1,
              total: pending.length,
            });
          }
          processed++;
          included.push(article);
        }
        // Recheck persisted settings after potentially long downloads/AI calls.
        for (let index = included.length - 1; index >= 0; index--) {
          const article = included[index]!;
          if (
            article.source.type !== "RSS" ||
            !article.source.articleLinkSelector ||
            !article.contentUrl
          )
            continue;
          try {
            await new JournalAccessService(this.db, this.articleContent).assertAccessible(
              userId,
              article.contentUrl,
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
        const now = new Date();
        const currentSettings = await getSettings(this.db, userId);
        const { newsletterId: _newsletterId, failure, ...runData } = result;
        await this.db.$transaction([
          this.db.dailyBriefRun.update({
            where: { id: run.id },
            data: { ...runData, error: failure?.message ?? null, finishedAt: now },
          }),
          this.db.dailyBriefSettings.update({
            where: { userId },
            data: {
              lastCollectionAt: now,
              ...(trigger === "scheduled"
                ? {
                    nextCollectionAt: currentSettings.collectionEnabled
                      ? nextCollection(
                          currentSettings.collectionTime,
                          currentSettings.timezone,
                          now,
                        )
                      : null,
                  }
                : {}),
            },
          }),
        ]);
      }
    });
  }
}
