import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Job } from "bullmq";
import IORedis from "ioredis";
import type {
  ArticleJobResult,
  ArticleJobsPage,
  ArticleJobStatus,
  CollectionProgress,
  CollectionRunSnapshot,
  QueueState,
  RunResult,
  DailyBriefSnapshot,
} from "@dailybrief/shared";
import type { Db } from "../db";
import type { Config } from "../config";
import type { RunTrigger } from "../collection";
import type { ProgressObserver } from "../progress";
import { AppError } from "../errors";
import { briefSnapshot } from "../daily-brief";

export type CollectionJobData = {
  userId: string;
  runId: string;
  trigger: RunTrigger;
  articleIds?: string[];
};
export type ArticleJobData = { userId: string; runId: string; articleId: string };
export type BriefJobData = { userId: string; runId: string; articleId?: never };
export type AiJobData = ArticleJobData | BriefJobData;
export type StoredProgress = {
  total: number | null;
  completed: number;
  failed: number;
  skipped: number;
  events: CollectionProgress[];
};
export const initialProgress = (): StoredProgress => ({
  total: null,
  completed: 0,
  failed: 0,
  skipped: 0,
  events: [],
});
export const queueState = (state: string): QueueState =>
  state === "completed" || state === "failed" || state === "delayed" || state === "active"
    ? state
    : "waiting";

// Producers fail promptly when Redis is unavailable. Workers use an unlimited reconnect policy.
export function queueConnection(config: Config, worker = false) {
  const connection = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: worker ? null : 1,
    enableReadyCheck: false,
  });
  connection.on("error", () => {});
  return connection;
}
const retention = { age: 30 * 24 * 60 * 60 };

export class JobsManager {
  readonly connection: IORedis;
  readonly collections: Queue<CollectionJobData, RunResult>;
  readonly summaries: Queue<AiJobData, ArticleJobResult>;
  private events?: QueueEvents;
  private eventsConnection?: IORedis;
  constructor(
    private db: Db,
    readonly config: Config,
  ) {
    this.connection = queueConnection(config);
    const options = {
      connection: this.connection,
      prefix: config.QUEUE_PREFIX,
      defaultJobOptions: { removeOnComplete: retention, removeOnFail: retention },
    };
    this.collections = new Queue("collections", options);
    this.summaries = new Queue("article-summaries", options);
    // One temporary completion listener per article is intentional; BullMQ removes it afterwards.
    this.summaries.setMaxListeners(0);
    for (const queue of [this.collections, this.summaries]) queue.on("error", () => {});
  }
  private activeKey(userId: string) {
    return `${this.config.QUEUE_PREFIX}:collection-active:${userId}`;
  }
  async enqueue(userId: string, trigger: RunTrigger = "manual"): Promise<CollectionRunSnapshot> {
    const mutex = `${this.activeKey(userId)}:enqueue`;
    const token = randomUUID();
    if (!(await this.connection.set(mutex, token, "PX", 30000, "NX")))
      throw new AppError(
        409,
        "Une collecte est en cours de création. Réessayez dans un instant.",
        "COLLECTION_RUNNING",
      );
    try {
      return await this.enqueueLocked(userId, trigger);
    } finally {
      await this.connection
        .eval(
          "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
          1,
          mutex,
          token,
        )
        .catch(() => {});
    }
  }
  private async enqueueLocked(userId: string, trigger: RunTrigger): Promise<CollectionRunSnapshot> {
    const key = this.activeKey(userId);
    const jobId = randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      const previousId = await this.connection.get(key);
      if (previousId) {
        const previous = await this.collections.getJob(previousId);
        if (previous && !["completed", "failed"].includes(await previous.getState()))
          return this.snapshot(userId, previous.data.runId);
        if (!previous) {
          const pending = await this.db.dailyBriefRun.findFirst({
            where: {
              userId,
              queueJobId: previousId,
              queuePrefix: this.config.QUEUE_PREFIX,
              finishedAt: null,
            },
          });
          if (pending) {
            await this.collections.add(
              "collect-sources",
              {
                userId,
                runId: pending.id,
                trigger: pending.trigger === "scheduled" ? "scheduled" : "manual",
              },
              { jobId: previousId, attempts: 3, backoff: { type: "exponential", delay: 5000 } },
            );
            return this.snapshot(userId, pending.id);
          }
        }
        await this.release(userId, previousId);
      }
      if (!(await this.connection.set(key, jobId, "NX"))) continue;
      let runId: string | undefined;
      try {
        const run = await this.db.dailyBriefRun.create({
          data: {
            userId,
            trigger,
            status: "QUEUED",
            queueJobId: jobId,
            queuePrefix: this.config.QUEUE_PREFIX,
          },
        });
        runId = run.id;
        await this.collections.add(
          "collect-sources",
          { userId, runId, trigger },
          {
            jobId,
            attempts: 3,
            backoff: { type: "exponential", delay: 5000 },
          },
        );
        return await this.snapshot(userId, runId);
      } catch (error) {
        // If add succeeded but the response was lost, retain the live job and its ownership key.
        if (runId && (await this.collections.getJob(jobId).catch(() => null)))
          return this.snapshot(userId, runId);
        if (runId)
          throw new AppError(
            503,
            "La collecte a été enregistrée. La file Redis est temporairement indisponible ; le traitement reprendra automatiquement.",
            "QUEUE_UNAVAILABLE",
          );
        await this.release(userId, jobId);
        throw error;
      }
    }
    throw new AppError(
      409,
      "Une collecte est déjà en cours. Actualisez sa progression.",
      "COLLECTION_RUNNING",
    );
  }
  async release(userId: string, jobId: string) {
    await this.connection.eval(
      "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      1,
      this.activeKey(userId),
      jobId,
    );
  }
  // PostgreSQL is also an outbox: recover a producer crash between creating the run and adding its Redis job.
  async recover() {
    let cursor: string | undefined;
    for (;;) {
      const runs = await this.db.dailyBriefRun.findMany({
        where: {
          finishedAt: null,
          queueJobId: { not: null },
          queuePrefix: this.config.QUEUE_PREFIX,
        },
        orderBy: { id: "asc" },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const run of runs) {
        if (await this.collections.getJob(run.queueJobId!)) continue;
        await this.connection.set(this.activeKey(run.userId), run.queueJobId!, "NX");
        try {
          const restored = await this.enqueue(
            run.userId,
            run.trigger === "scheduled" ? "scheduled" : "manual",
          );
          if (restored.id !== run.id)
            await this.db.dailyBriefRun.updateMany({
              where: { id: run.id, finishedAt: null },
              data: {
                status: "FAILED",
                finishedAt: new Date(),
                error:
                  "Cette collecte interrompue a été remplacée par une récupération plus récente.",
              },
            });
        } catch (error) {
          if (!(error instanceof AppError && error.code === "COLLECTION_RUNNING")) throw error;
        }
      }
      if (runs.length < 100) return;
      cursor = runs.at(-1)!.id;
    }
  }
  async current(userId: string) {
    const run = await this.db.dailyBriefRun.findFirst({
      where: { userId, queueJobId: { not: null }, queuePrefix: this.config.QUEUE_PREFIX },
      orderBy: { startedAt: "desc" },
    });
    return run ? this.snapshot(userId, run.id) : null;
  }
  async list(userId: string): Promise<CollectionRunSnapshot[]> {
    const runs = await this.db.dailyBriefRun.findMany({
      where: { userId, queueJobId: { not: null }, queuePrefix: this.config.QUEUE_PREFIX },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    return Promise.all(runs.map((run) => this.snapshot(userId, run.id)));
  }
  async snapshot(userId: string, runId: string): Promise<CollectionRunSnapshot> {
    let run = await this.ownedRun(userId, runId);
    let job = run.queueJobId ? await this.collections.getJob(run.queueJobId) : null;
    const state = job
      ? queueState(await job.getState())
      : run.status === "FAILED"
        ? "failed"
        : run.finishedAt
          ? "completed"
          : "waiting";
    if (["completed", "failed"].includes(state)) {
      // Completion can happen between the SQL read and Redis getState; refresh the final result.
      [run, job] = await Promise.all([
        this.ownedRun(userId, runId),
        this.collections.getJob(run.queueJobId!),
      ]);
    }
    const progress =
      job && typeof job.progress === "object"
        ? (job.progress as StoredProgress)
        : initialProgress();
    const result: RunResult | null = job?.returnvalue?.status
      ? job.returnvalue
      : run.finishedAt
        ? {
            status: run.status as RunResult["status"],
            sourcesProcessed: run.sourcesProcessed,
            sourcesFailed: run.sourcesFailed,
            articlesCollected: run.articlesCollected,
            newArticles: run.newArticles,
            articlesSummarized: run.articlesSummarized,
            emailSent: run.emailSent,
            ...(run.newsletterId ? { newsletterId: run.newsletterId } : {}),
            ...(run.brief
              ? {
                  briefId: run.brief.id,
                  briefStatus: run.brief.status as DailyBriefSnapshot["status"],
                }
              : {}),
            ...(run.error
              ? { failure: { stage: "collection", code: "COLLECTION_FAILED", message: run.error } }
              : {}),
          }
        : null;
    return {
      id: run.id,
      trigger: run.trigger === "scheduled" ? "scheduled" : "manual",
      state,
      active: !["completed", "failed"].includes(state),
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      ...progress,
      result,
      error:
        run.error ??
        (state === "failed"
          ? "Le traitement a échoué. Consultez les étapes et relancez la récupération."
          : null),
    };
  }
  private async ownedRun(userId: string, id: string) {
    const run = await this.db.dailyBriefRun.findFirst({
      where: { id, userId, queueJobId: { not: null }, queuePrefix: this.config.QUEUE_PREFIX },
      include: { brief: true },
    });
    if (!run) throw new AppError(404, "Collecte introuvable.", "NOT_FOUND");
    return run;
  }
  async jobs(
    userId: string,
    runId: string,
    requestedPage = 1,
    status: ArticleJobStatus = "all",
  ): Promise<ArticleJobsPage> {
    const run = await this.ownedRun(userId, runId);
    const root = await this.collections.getJob(run.queueJobId!);
    const ids = root?.data.articleIds ?? [];
    const pageSize = 5;
    type Selection = { articleId: string; state?: QueueState; skipped?: boolean };
    let matching: Selection[] = ids.map((articleId) => ({ articleId }));
    if (status !== "all") {
      matching = [];
      // Read only queue metadata for filtering, in bounded batches. Article bodies and
      // summaries are fetched from PostgreSQL only for the five selected rows.
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = await Promise.all(
          ids.slice(offset, offset + 100).map(async (articleId) => {
            const jobId = `${run.queueJobId}-${articleId}`;
            const rawState = await this.summaries.getJobState(jobId);
            const state =
              rawState === "unknown"
                ? run.finishedAt
                  ? "completed"
                  : "waiting"
                : queueState(rawState);
            let skipped = false;
            if (state === "completed" && (status === "completed" || status === "skipped")) {
              const job = await this.summaries.getJob(jobId);
              if (job && job.data.userId !== userId)
                throw new AppError(404, "Job introuvable.", "NOT_FOUND");
              skipped = job?.returnvalue?.status === "skipped";
            }
            const matches =
              status === "waiting"
                ? state === "waiting" || state === "delayed"
                : status === "skipped"
                  ? state === "completed" && skipped
                  : status === "completed"
                    ? state === "completed" && !skipped
                    : state === status;
            return matches ? { articleId, state, skipped } : null;
          }),
        );
        for (const item of batch) if (item) matching.push(item);
      }
    }
    const total = matching.length;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const offset = (page - 1) * pageSize;
    const rows = await Promise.all(
      matching.slice(offset, offset + pageSize).map(async (selection) => {
        const { articleId } = selection;
        const [job, article] = await Promise.all([
          this.summaries.getJob(`${run.queueJobId}-${articleId}`),
          this.db.article.findFirst({
            where: { id: articleId, userId },
            select: {
              title: true,
              source: { select: { url: true } },
              summaryTitle: true,
              summary: true,
              keyPoints: true,
              summarizedAt: true,
              relevanceReason: true,
            },
          }),
        ]);
        if (job && job.data.userId !== userId)
          throw new AppError(404, "Job introuvable.", "NOT_FOUND");
        const state =
          selection.state ??
          (job ? queueState(await job.getState()) : run.finishedAt ? "completed" : "waiting");
        const progress =
          job && typeof job.progress === "object" ? (job.progress as CollectionProgress) : null;
        const skipped = selection.skipped ?? job?.returnvalue?.status === "skipped";
        return {
          id: `${run.queueJobId}-${articleId}`,
          articleId,
          title: article?.title ?? "Article supprimé",
          sourceUrl: article?.source.url ?? "",
          state,
          attempts: job?.attemptsMade ?? 0,
          skipped,
          progress,
          error:
            state === "failed"
              ? (progress?.message ?? "Le traitement de l'article a échoué.")
              : null,
          relevanceReason: skipped ? (article?.relevanceReason ?? null) : null,
          summary:
            state === "completed" && !skipped && article?.summary && article.summarizedAt
              ? {
                  title: article.summaryTitle ?? article.title,
                  summary: article.summary,
                  keyPoints: article.keyPoints,
                }
              : null,
        };
      }),
    );
    return { jobs: rows, total, page, pageSize };
  }
  async dispatch(
    root: Job<CollectionJobData, RunResult>,
    articleIds: string[],
    observer?: ProgressObserver,
  ): Promise<ArticleJobResult[]> {
    if (!this.events) {
      this.eventsConnection = queueConnection(this.config, true);
      this.events = new QueueEvents("article-summaries", {
        connection: this.eventsConnection,
        prefix: this.config.QUEUE_PREFIX,
      });
      this.events.on("error", () => {});
      this.events.setMaxListeners(0);
    }
    await this.events.waitUntilReady();
    const ids = root.data.articleIds ?? articleIds;
    await root.updateData({ ...root.data, articleIds: ids });
    const jobs = await this.summaries.addBulk(
      ids.map((articleId) => ({
        name: "scraping-summary",
        data: { userId: root.data.userId, runId: root.data.runId, articleId },
        opts: {
          jobId: `${root.id}-${articleId}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      })),
    );
    const jobIds = new Set(jobs.map((job) => job.id!));
    const relay = ({ jobId, data }: { jobId: string; data: unknown }) => {
      if (!jobIds.has(jobId) || typeof data !== "object") return;
      const { completed: _completed, total: _total, ...event } = data as CollectionProgress;
      if (event.stage && event.message && event.at) observer?.(event);
    };
    this.events.on("progress", relay);
    let completed = 0,
      failed = 0,
      skipped = 0;
    observer?.({
      stage: "ai",
      status: "running",
      at: new Date().toISOString(),
      message: `${ids.length} jobs d'articles en file d'attente.`,
      completed: 0,
      total: ids.length,
    });
    try {
      return await Promise.all(
        jobs.map(async (job) => {
          let outcome: ArticleJobResult;
          try {
            outcome = await job.waitUntilFinished(this.events!);
          } catch {
            const fresh = await this.summaries.getJob(job.id!);
            const event =
              fresh && typeof fresh.progress === "object"
                ? (fresh.progress as CollectionProgress & { failure?: ArticleJobResult["failure"] })
                : null;
            outcome = {
              articleId: job.data.articleId!,
              status: "failed",
              newSummary: false,
              failure: event?.failure ?? {
                stage: "ai",
                code: "ARTICLE_JOB_FAILED",
                message: "Le traitement de l'article a échoué après plusieurs tentatives.",
              },
            };
          }
          completed++;
          if (outcome.status === "failed") failed++;
          if (outcome.status === "skipped") skipped++;
          observer?.({
            stage: "ai",
            status:
              outcome.status === "failed"
                ? "failed"
                : outcome.status === "skipped"
                  ? "skipped"
                  : "completed",
            at: new Date().toISOString(),
            message: `${completed}/${ids.length} articles traités (${failed} en échec, ${skipped} ignorés).`,
            completed,
            total: ids.length,
          });
          return outcome;
        }),
      );
    } finally {
      this.events.off("progress", relay);
    }
  }
  async dispatchBrief(
    root: Job<CollectionJobData, RunResult>,
    observer?: ProgressObserver,
  ): Promise<DailyBriefSnapshot> {
    if (!this.events) {
      this.eventsConnection = queueConnection(this.config, true);
      this.events = new QueueEvents("article-summaries", {
        connection: this.eventsConnection,
        prefix: this.config.QUEUE_PREFIX,
      });
      this.events.on("error", () => {});
      this.events.setMaxListeners(0);
    }
    await this.events.waitUntilReady();
    const job = await this.summaries.add(
      "daily-brief",
      { userId: root.data.userId, runId: root.data.runId },
      {
        jobId: `${root.id}-daily-brief`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );
    const relay = ({ jobId, data }: { jobId: string; data: unknown }) => {
      if (jobId === job.id && typeof data === "object" && data) {
        const progress = data as CollectionProgress;
        if (progress.stage === "brief" && progress.message && progress.at) observer?.(progress);
      }
    };
    this.events.on("progress", relay);
    try {
      await job.waitUntilFinished(this.events);
      const brief = await this.db.dailyBrief.findFirst({
        where: { userId: root.data.userId, runId: root.data.runId },
      });
      if (!brief || !["READY", "EMPTY"].includes(brief.status))
        throw new AppError(502, "La génération du Daily Brief a échoué.", "BRIEF_FAILED");
      return briefSnapshot(brief);
    } catch {
      throw new AppError(
        502,
        "La génération du Daily Brief a échoué après plusieurs tentatives. Les résumés restent disponibles.",
        "BRIEF_FAILED",
      );
    } finally {
      this.events.off("progress", relay);
    }
  }
  async close() {
    await Promise.all([this.collections.close(), this.summaries.close(), this.events?.close()]);
    await Promise.all([this.connection.quit(), this.eventsConnection?.quit()]);
  }
}
