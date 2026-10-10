import { Worker, UnrecoverableError, type Job } from "bullmq";
import type { RunResult, ArticleJobResult, CollectionProgress } from "@dailybrief/shared";
import type { Db } from "../db";
import type { ProgressObserver } from "../progress";
import { DailyBriefPipelineService } from "../pipeline";
import { AppError } from "../errors";
import { failureFor } from "./failure";
import { ScrapingSummaryProcessor } from "./scraping-summary";
import {
  JobsManager,
  queueConnection,
  initialProgress,
  type CollectionJobData,
  type ArticleJobData,
  type StoredProgress,
} from "./jobs-manager";

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
  ) => DailyBriefPipelineService,
  processor: ScrapingSummaryProcessor,
) {
  const connection = queueConnection(manager.config, true);
  // Across all worker processes, keep Ollama's heavy requests bounded.
  await manager.summaries.setGlobalConcurrency(manager.config.AI_CONCURRENCY);
  await manager.collections.setGlobalConcurrency(manager.config.COLLECTION_CONCURRENCY);
  const summaries = new Worker<ArticleJobData, ArticleJobResult>(
    "article-summaries",
    async (job) => {
      const run = await db.dailyBriefRun.findFirst({
        where: {
          id: job.data.runId,
          userId: job.data.userId,
          queuePrefix: manager.config.QUEUE_PREFIX,
        },
      });
      if (!run || run.finishedAt)
        return { articleId: job.data.articleId, status: "skipped", newSummary: false };
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
        const outcome = await processor.run(
          job.data.userId,
          job.data.articleId,
          report,
          undefined,
          assertOwned,
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
        const failure = knownFailure ?? failureFor(error, "ai");
        await job.updateProgress({
          stage: failure.stage,
          status: "failed",
          at: new Date().toISOString(),
          message: failure.message,
          failure,
        });
        throw new Error(failure.message);
      }
    },
    { connection, prefix: manager.config.QUEUE_PREFIX, concurrency: manager.config.AI_CONCURRENCY },
  );
  const collections = new Worker<CollectionJobData, RunResult>(
    "collections",
    async (job) => {
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
      const pipeline = makePipeline((_userId, _runId, ids, observer) =>
        manager.dispatch(job, ids, observer),
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
          throw new UnrecoverableError(result.failure?.message ?? "La collecte a échoué.");
        return result;
      } catch (error) {
        await writes;
        if (error instanceof UnrecoverableError) throw error;
        throw new Error(failureFor(error, "collection").message);
      }
    },
    {
      connection,
      prefix: manager.config.QUEUE_PREFIX,
      concurrency: manager.config.COLLECTION_CONCURRENCY,
    },
  );
  for (const worker of [summaries, collections])
    worker.on("error", () => console.error("Erreur de connexion du consommateur Redis."));
  const release = async (job: Job<CollectionJobData, RunResult>) => {
    try {
      await manager.release(job.data.userId, job.id!);
    } catch {
      console.error("Impossible de libérer l'état de la collecte.");
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
    })().catch(() => console.error("Impossible de finaliser le job de collecte."));
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
