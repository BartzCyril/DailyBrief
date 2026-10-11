import { Worker, UnrecoverableError, type Job } from "bullmq";
import type { RunResult, ArticleJobResult, CollectionProgress } from "@dailybrief/shared";
import type { Db } from "../db";
import type { ProgressObserver } from "../progress";
import { DailyBriefPipelineService } from "../pipeline";
import type { BriefDispatcher } from "../pipeline";
import { AppError } from "../errors";
import { failureFor } from "./failure";
import { ScrapingSummaryProcessor } from "./scraping-summary";
import { logger, withLogContext } from "../logger";
import {
  JobsManager,
  queueConnection,
  initialProgress,
  type CollectionJobData,
  type AiJobData,
  type StoredProgress,
} from "./jobs-manager";

function jobContext(job: Job<AiJobData | CollectionJobData>, queue: string) {
  return {
    queue,
    jobId: job.id,
    runId: job.data.runId,
    userId: job.data.userId,
    ...("articleId" in job.data ? { articleId: job.data.articleId } : {}),
    attempt: job.attemptsStarted,
  };
}

export async function startConsumers(
  db: Db,
  manager: JobsManager,
  makePipeline: (
    dispatch: (
      userId: string,
      runId: string,
      ids: string[],
      observer?: ProgressObserver,
    ) => Promise<ArticleJobResult[]>,
    finalize: BriefDispatcher,
  ) => DailyBriefPipelineService,
  processor: ScrapingSummaryProcessor,
) {
  const connection = queueConnection(manager.config, true);
  // Across all worker processes, keep Ollama's heavy requests bounded.
  await manager.summaries.setGlobalConcurrency(manager.config.AI_CONCURRENCY);
  await manager.collections.setGlobalConcurrency(manager.config.COLLECTION_CONCURRENCY);
  const summaries = new Worker<AiJobData, ArticleJobResult>(
    "article-summaries",
    async (job) =>
      withLogContext(jobContext(job, "article-summaries"), async () => {
        logger.info("job.started", "Traitement d'un job IA.", { kind: job.name });
        const run = await db.dailyBriefRun.findFirst({
          where: {
            id: job.data.runId,
            userId: job.data.userId,
            queuePrefix: manager.config.QUEUE_PREFIX,
          },
        });
        if (!run || run.finishedAt)
          return {
            articleId: job.data.articleId ?? job.data.runId,
            status: "skipped",
            newSummary: false,
          };
        let writes = Promise.resolve();
        let knownFailure: ArticleJobResult["failure"];
        const report: ProgressObserver = (event) => {
          writes = writes.then(() => job.updateProgress(event));
        };
        const assertOwned = async () => {
          if (!job.token || !(await job.extendLock(job.token, 30000)))
            throw new AppError(
              409,
              "Le verrou du job a expiré. Le traitement sera repris.",
              "LOCK_LOST",
            );
          const currentRun = await db.dailyBriefRun.findFirst({
            where: {
              id: job.data.runId,
              userId: job.data.userId,
              queuePrefix: manager.config.QUEUE_PREFIX,
              finishedAt: null,
            },
          });
          if (!currentRun)
            throw new AppError(
              409,
              "La collecte est terminée. Relancez la récupération.",
              "COLLECTION_FINISHED",
            );
        };
        try {
          if (job.name === "daily-brief") {
            await processor.brief(job.data.userId, job.data.runId, report, assertOwned);
            await writes;
            return { articleId: job.data.runId, status: "completed", newSummary: false };
          }
          if (!job.data.articleId) throw new UnrecoverableError("Le job d'article est invalide.");
          const outcome = await processor.run(
            job.data.userId,
            job.data.articleId,
            report,
            undefined,
            assertOwned,
            run.interestPrompt ?? undefined,
          );
          await writes;
          if (outcome.status === "failed") {
            const failure = outcome.failure!;
            knownFailure = failure;
            await job.updateProgress({
              stage: failure.stage,
              status: "failed",
              at: new Date().toISOString(),
              message: failure.message,
              failure,
            });
            const permanent = [
              "MODEL_MISSING",
              "ARTICLE_LINK_UNRESOLVED",
              "JOURNAL_ACCESS_CHANGED",
              "SOURCE_CHANGED",
              "JOURNAL_AUTH_UNSUPPORTED",
              "JOURNAL_LOGIN_FAILED",
            ].includes(failure.code);
            if (permanent) throw new UnrecoverableError(failure.message);
            throw new AppError(502, failure.message, failure.code);
          }
          return outcome;
        } catch (error) {
          await writes;
          // Never expose unexpected exceptions, provider responses, cookies or secrets in Redis.
          if (error instanceof UnrecoverableError) throw error;
          const failure =
            knownFailure ?? failureFor(error, job.name === "daily-brief" ? "brief" : "ai");
          await job.updateProgress({
            stage: failure.stage,
            status: "failed",
            at: new Date().toISOString(),
            message: failure.message,
            failure,
          });
          if (
            job.name === "daily-brief" &&
            ["MODEL_MISSING", "BRIEF_UNAVAILABLE", "COLLECTION_FINISHED"].includes(failure.code)
          )
            throw new UnrecoverableError(failure.message);
          throw new Error(failure.message);
        }
      }),
    { connection, prefix: manager.config.QUEUE_PREFIX, concurrency: manager.config.AI_CONCURRENCY },
  );
  const collections = new Worker<CollectionJobData, RunResult>(
    "collections",
    async (job) =>
      withLogContext(jobContext(job, "collections"), async () => {
        logger.info("job.started", "Traitement d'une collecte.");
        let progress =
          typeof job.progress === "object" ? (job.progress as StoredProgress) : initialProgress();
        let writes = Promise.resolve();
        const report: ProgressObserver = (event) => {
          if (event.stage === "ai" && event.total !== undefined && event.completed !== undefined) {
            if (event.completed === 0) progress = { ...progress, failed: 0, skipped: 0 };
            progress = {
              ...progress,
              total: event.total,
              completed: event.completed,
              failed: progress.failed + (event.status === "failed" ? 1 : 0),
              skipped: progress.skipped + (event.status === "skipped" ? 1 : 0),
            };
          }
          progress = { ...progress, events: [...progress.events, event].slice(-100) };
          const snapshot = progress;
          writes = writes.then(() => job.updateProgress(snapshot));
        };
        const pipeline = makePipeline(
          (_userId, _runId, ids, observer) => manager.dispatch(job, ids, observer),
          (_userId, _runId, observer) => manager.dispatchBrief(job, observer),
        );
        try {
          const result = await pipeline.run(
            job.data.userId,
            job.data.trigger,
            report,
            job.data.runId,
          );
          await writes;
          if (result.status === "FAILED")
            throw Object.assign(
              new UnrecoverableError(result.failure?.message ?? "La collecte a échoué."),
              { code: result.failure?.code ?? "COLLECTION_FAILED" },
            );
          return result;
        } catch (error) {
          await writes;
          if (error instanceof UnrecoverableError) throw error;
          throw new Error(failureFor(error, "collection").message);
        }
      }),
    {
      connection,
      prefix: manager.config.QUEUE_PREFIX,
      concurrency: manager.config.COLLECTION_CONCURRENCY,
    },
  );
  for (const worker of [summaries, collections]) {
    worker.on("error", (error) =>
      logger.error("consumer.failed", "Erreur du consommateur Redis.", {
        queue: worker.name,
        error,
      }),
    );
    worker.on("completed", (job, result) => {
      logger.info("job.completed", "Job terminé.", {
        ...jobContext(job, worker.name),
        status: result.status,
        ...("newSummary" in result ? { newSummary: result.newSummary } : {}),
        durationMs:
          job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined,
      });
    });
    worker.on("failed", (job, error) => {
      if (!job) return;
      void (async () => {
        const progress =
          typeof job.progress === "object"
            ? (job.progress as { failure?: { code?: string; stage?: string } })
            : undefined;
        const context = {
          ...jobContext(job, worker.name),
          attemptsMade: job.attemptsMade,
          failureCode: progress?.failure?.code,
          stage: progress?.failure?.stage,
          error,
        };
        if ((await job.getState()) === "failed")
          logger.error("job.failed", "Job en échec définitif.", context);
        else logger.debug("job.retry", "Une nouvelle tentative du job est prévue.", context);
      })().catch((error) =>
        logger.error("job.state_failed", "Impossible de vérifier l'état du job en échec.", {
          jobId: job.id,
          error,
        }),
      );
    });
  }
  const release = async (job: Job<CollectionJobData, RunResult>) => {
    try {
      await manager.release(job.data.userId, job.id!);
    } catch (error) {
      logger.error("collection.release_failed", "Impossible de libérer l'état de la collecte.", {
        ...jobContext(job, "collections"),
        error,
      });
    }
  };
  collections.on("completed", (job) => {
    void release(job);
  });
  collections.on("failed", (job) => {
    if (!job) return;
    void (async () => {
      if ((await job.getState()) !== "failed") return;
      await db.dailyBriefRun.updateMany({
        where: {
          id: job.data.runId,
          userId: job.data.userId,
          queuePrefix: manager.config.QUEUE_PREFIX,
          finishedAt: null,
        },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: "La collecte a échoué après plusieurs tentatives.",
        },
      });
      await release(job);
    })().catch((error) =>
      logger.error("collection.finalize_failed", "Impossible de finaliser le job de collecte.", {
        ...jobContext(job, "collections"),
        error,
      }),
    );
  });
  await Promise.all([summaries.waitUntilReady(), collections.waitUntilReady()]);
  return {
    collections,
    summaries,
    async close() {
      // Complete active work before disconnecting Redis or the database.
      await collections.close();
      await summaries.close();
      await connection.quit();
    },
  };
}
