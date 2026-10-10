import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { JobsManager } from "../src/queue/jobs-manager";
import { startConsumers } from "../src/queue/consumers";
import { ScrapingSummaryProcessor } from "../src/queue/scraping-summary";
import { DailyBriefPipelineService } from "../src/pipeline";
import { SourceCollector } from "../src/collection";
import { RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { ArticleContentService } from "../src/article-content";
import { JournalAccessService } from "../src/journal-access";
import { UserCollectionLock } from "../src/lock";
import { runDueCollections } from "../src/scheduler";
import { createApp } from "../src/app";
import { AppError } from "../src/errors";
import { articleIdentity } from "../src/fingerprint";
import type { SummaryProvider } from "../src/ai";
import { config, db, redis, connect, disconnect } from "./helpers";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error("Queue did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

const queueTest = (name: string, action: () => Promise<void>) => test(name, action, 30000);
describe("durable collection queue", () => {
  const prefix = `test-queue-${randomUUID()}`;
  const queueConfig = { ...config, QUEUE_PREFIX: prefix };
  let manager: JobsManager;
  let consumers: Awaited<ReturnType<typeof startConsumers>> | undefined;
  const users: string[] = [];
  let calls = 0;
  let sends = 0;
  let release = () => {};
  let gate = Promise.resolve();
  let summaryFailure: string | null = null;
  let transientFailures = 0;
  const summary: SummaryProvider = {
    async summarize(article, observer) {
      calls++;
      observer?.("Résumé IA en cours");
      await gate;
      if (summaryFailure)
        throw new AppError(503, "Le modèle de test est indisponible.", summaryFailure);
      if (transientFailures-- > 0)
        throw new AppError(503, "Service IA temporairement indisponible.", "AI_UNAVAILABLE");
      return { title: article.title, summary: `Résumé ${article.title}`, keyPoints: ["Point"] };
    },
  };
  const content = new ArticleContentService(
    async () => `<article><p>${"Contenu complet et public à analyser. ".repeat(40)}</p></article>`,
  );
  const journals = new JournalAccessService(db, content);
  const rss = new RssService(async (url) => {
    const size = url.includes("first") ? 10 : 5;
    return `<rss><channel><title>Test</title>${Array.from({ length: size }, (_, i) => `<item><title>${url.includes("first") ? "Premier" : "Second"} article ${i}</title><link>https://article.example/${url.includes("first") ? "a" : "b"}/${i}</link><description>Description distincte ${url} ${i}</description></item>`).join("")}</channel></rss>`;
  });
  const makePipeline = (dispatch?: ConstructorParameters<typeof DailyBriefPipelineService>[7]) =>
    new DailyBriefPipelineService(
      db,
      new SourceCollector(db, rss, new ScrapingService(), content),
      new UserCollectionLock(redis, 30000),
      summary,
      {
        async send() {
          sends++;
        },
      },
      content,
      journals,
      dispatch,
    );
  async function start() {
    consumers = await startConsumers(
      db,
      manager,
      makePipeline,
      new ScrapingSummaryProcessor(db, summary, content, journals),
    );
  }
  async function user(withSources = true) {
    const row = await db.user.create({
      data: { email: `${randomUUID()}@queue.example`, passwordHash: "unused" },
    });
    users.push(row.id);
    if (withSources)
      await db.source.createMany({
        data: ["first", "second"].map((name) => ({
          userId: row.id,
          url: `https://feed.example/${name}`,
          type: "RSS" as const,
        })),
      });
    return row;
  }
  beforeAll(async () => {
    await connect();
    manager = new JobsManager(db, queueConfig);
  });
  afterAll(async () => {
    release();
    await consumers?.close();
    await manager.collections.obliterate({ force: true });
    await manager.summaries.obliterate({ force: true });
    const keys = await manager.connection.keys(`${prefix}:*`);
    if (keys.length) await manager.connection.del(...keys);
    await manager.close();
    await db.user.deleteMany({ where: { id: { in: users } } });
    await disconnect();
  });
  queueTest(
    "queues immediately without a worker, then creates 15 article jobs and restores progress after reconnect",
    async () => {
      const owner = await user();
      const waiting = await manager.enqueue(owner.id);
      expect(waiting.state).toBe("waiting");
      expect(waiting.total).toBeNull();
      expect(calls).toBe(0);
      expect((await manager.enqueue(owner.id)).id).toBe(waiting.id);
      gate = new Promise((resolve) => {
        release = resolve;
      });
      await start();
      const running = await until(
        () => manager.snapshot(owner.id, waiting.id),
        (value) => value.total === 15,
      );
      expect(running.active).toBe(true);
      expect(running.completed).toBe(0);
      const rows = await manager.jobs(owner.id, waiting.id);
      expect(rows.total).toBe(15);
      expect(rows.jobs).toHaveLength(10);
      expect((await manager.jobs(owner.id, waiting.id, 2)).jobs).toHaveLength(5);
      expect((await manager.enqueue(owner.id)).id).toBe(waiting.id);
      const reconnected = new JobsManager(db, queueConfig);
      expect((await reconnected.current(owner.id))?.id).toBe(waiting.id);
      expect((await reconnected.current(owner.id))?.total).toBe(15);
      await reconnected.close();
      const raw = await manager.summaries.getJobs(["active", "waiting"]);
      for (const job of raw)
        expect(Object.keys(job.data).sort()).toEqual(["articleId", "runId", "userId"]);
      release();
      gate = Promise.resolve();
      const finished = await until(
        () => manager.snapshot(owner.id, waiting.id),
        (value) => !value.active,
      );
      expect(finished.result?.status).toBe("SENT");
      expect(finished.completed).toBe(15);
      expect(finished.failed).toBe(0);
      expect(calls).toBe(15);
      expect(sends).toBe(1);
      expect(await db.article.count({ where: { userId: owner.id, summary: { not: null } } })).toBe(
        15,
      );
      const again = await manager.enqueue(owner.id);
      expect(
        (
          await until(
            () => manager.snapshot(owner.id, again.id),
            (value) => !value.active,
          )
        ).result?.status,
      ).toBe("NO_NEW_ARTICLES");
      expect(calls).toBe(15);
      expect(sends).toBe(1);
    },
  );
  queueTest("daily runs enqueue the same queue and do not duplicate a pending run", async () => {
    await consumers!.close();
    consumers = undefined;
    const owner = await user(false);
    await db.dailyBriefSettings.create({
      data: { userId: owner.id, collectionEnabled: true, nextCollectionAt: new Date(0) },
    });
    const adapter = {
      run: (userId: string, trigger?: "manual" | "scheduled") => manager.enqueue(userId, trigger),
    };
    await runDueCollections(db, adapter);
    await runDueCollections(db, adapter);
    const runs = await manager.list(owner.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("scheduled");
    expect(runs[0]?.state).toBe("waiting");
    await start();
    await until(
      () => manager.current(owner.id),
      (value) => !!value && !value.active,
    );
    expect(
      (
        await db.dailyBriefSettings.findUniqueOrThrow({ where: { userId: owner.id } })
      ).nextCollectionAt!.getTime(),
    ).toBeGreaterThan(Date.now());
  });
  queueTest(
    "authenticated endpoints return 202 and isolate runs and jobs between users",
    async () => {
      const first = await user(false),
        second = await user(false);
      const run = await manager.enqueue(first.id);
      await expect(manager.snapshot(second.id, run.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(manager.jobs(second.id, run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await manager.current(second.id)).toBeNull();
      const app = createApp(db, redis, queueConfig, { collections: manager });
      expect((await request(app).get("/collection/current")).status).toBe(401);
      const agent = request.agent(app);
      const email = `${randomUUID()}@queue.example`;
      const registered = await agent
        .post("/auth/register")
        .send({ email, password: "SecurePassword123!" });
      users.push(registered.body.id);
      expect(registered.status).toBe(201);
      expect(
        (await agent.post("/auth/login").send({ email, password: "SecurePassword123!" })).status,
      ).toBe(200);
      expect((await agent.post("/collection/run").send({ userId: first.id })).status).toBe(400);
      const queued = await agent.post("/collection/run").send({});
      expect(queued.status).toBe(202);
      expect(queued.body.id).toBeDefined();
      expect((await agent.get(`/collection/runs/${run.id}/jobs`)).status).toBe(404);
      await until(
        () => manager.snapshot(registered.body.id, queued.body.id),
        (value) => !value.active,
      );
    },
  );
  queueTest(
    "permanent AI failures remain visible and preserve unsummarized articles for the next run",
    async () => {
      const owner = await user();
      summaryFailure = "MODEL_MISSING";
      const before = calls;
      const queued = await manager.enqueue(owner.id);
      const failed = await until(
        () => manager.snapshot(owner.id, queued.id),
        (value) => !value.active,
      );
      expect(failed.state).toBe("failed");
      expect(failed.failed).toBe(15);
      expect(failed.completed).toBe(15);
      expect(calls - before).toBe(15);
      const rows = await manager.jobs(owner.id, queued.id);
      expect(rows.jobs.every((job) => job.state === "failed" && job.attempts === 1)).toBe(true);
      summaryFailure = null;
      const retry = await manager.enqueue(owner.id);
      expect(
        (
          await until(
            () => manager.snapshot(owner.id, retry.id),
            (value) => !value.active,
          )
        ).result?.status,
      ).toBe("SENT");
    },
  );
  queueTest("a transient article failure retries only that job", async () => {
    const owner = await user();
    transientFailures = 1;
    const before = calls;
    const queued = await manager.enqueue(owner.id);
    const done = await until(
      () => manager.snapshot(owner.id, queued.id),
      (value) => !value.active,
    );
    expect(done.result?.status).toBe("SENT");
    expect(done.completed).toBe(15);
    expect(done.failed).toBe(0);
    expect(calls - before).toBe(16);
    expect((await manager.jobs(owner.id, queued.id)).jobs.some((job) => job.attempts === 2)).toBe(
      true,
    );
  });
  queueTest("worker restart reuses completed jobs from the durable article batch", async () => {
    await consumers!.collections.pause();
    const owner = await user();
    const queued = await manager.enqueue(owner.id);
    const root = await manager.collections.getJob(
      (await db.dailyBriefRun.findUniqueOrThrow({ where: { id: queued.id } })).queueJobId!,
    );
    const sources = await new SourceCollector(db, rss, new ScrapingService(), content).collect(
      owner.id,
    );
    const articles = [];
    for (const article of sources.flatMap((source) => source.articles))
      articles.push(
        await db.article.create({
          data: {
            userId: owner.id,
            sourceId: article.sourceId,
            title: article.title,
            url: article.url,
            content: article.content,
            ...articleIdentity(article),
          },
        }),
      );
    await root!.updateData({ ...root!.data, articleIds: articles.map((article) => article.id) });
    const before = calls;
    const first = await manager.summaries.add(
      "scraping-summary",
      { userId: owner.id, runId: queued.id, articleId: articles[0]!.id },
      { jobId: `${root!.id}-${articles[0]!.id}` },
    );
    await until(
      () => first.getState(),
      (state) => state === "completed",
    );
    expect(calls - before).toBe(1);
    await consumers!.close();
    consumers = undefined;
    await start();
    const finished = await until(
      () => manager.snapshot(owner.id, queued.id),
      (value) => !value.active,
    );
    expect(finished.result?.status).toBe("SENT");
    expect(finished.completed).toBe(15);
    expect(calls - before).toBe(15);
    expect((await manager.jobs(owner.id, queued.id)).jobs[0]?.attempts).toBe(1);
  });
  queueTest("recovery never sends again a SENT or uncertain SENDING newsletter", async () => {
    for (const status of ["SENT", "SENDING"] as const) {
      await consumers!.collections.pause();
      const owner = await user(false);
      const queued = await manager.enqueue(owner.id);
      const newsletter = await db.newsletter.create({
        data: { userId: owner.id, recipientEmail: owner.email, subject: "Recovery", status },
      });
      await db.dailyBriefRun.update({
        where: { id: queued.id },
        data: { status: "RUNNING", newsletterId: newsletter.id },
      });
      const before = sends;
      await consumers!.collections.resume();
      const finished = await until(
        () => manager.snapshot(owner.id, queued.id),
        (value) => !value.active,
      );
      expect(finished.result?.status).toBe(status === "SENT" ? "SENT" : "FAILED");
      expect(finished.result?.emailSent).toBe(status === "SENT");
      expect(sends).toBe(before);
      if (status === "SENDING") expect(finished.error).toContain("incertain");
    }
  });
  queueTest(
    "an interrupted producer is recovered from PostgreSQL without creating another run",
    async () => {
      await consumers!.collections.pause();
      const owner = await user(false);
      const add = spyOn(manager.collections, "add").mockRejectedValueOnce(
        new Error("Temporary Redis error"),
      );
      try {
        await expect(manager.enqueue(owner.id)).rejects.toMatchObject({
          code: "QUEUE_UNAVAILABLE",
        });
      } finally {
        add.mockRestore();
      }
      const pending = await manager.current(owner.id);
      expect(pending?.active).toBe(true);
      expect(await db.dailyBriefRun.count({ where: { userId: owner.id } })).toBe(1);
      await manager.recover();
      expect((await manager.current(owner.id))?.id).toBe(pending!.id);
      expect(await db.dailyBriefRun.count({ where: { userId: owner.id } })).toBe(1);
      await consumers!.collections.resume();
      const recovered = await until(
        () => manager.current(owner.id),
        (value) => !!value && !value.active,
      );
      expect(recovered?.result?.status).toBe("NO_NEW_ARTICLES");
      const other = new JobsManager(db, { ...queueConfig, QUEUE_PREFIX: `${prefix}-other` });
      try {
        const foreignOwner = await user(false);
        const foreign = await other.enqueue(foreignOwner.id);
        await manager.recover();
        expect(await manager.current(foreignOwner.id)).toBeNull();
        await expect(manager.snapshot(foreignOwner.id, foreign.id)).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        expect((await other.snapshot(foreignOwner.id, foreign.id)).state).toBe("waiting");
      } finally {
        await other.collections.obliterate({ force: true });
        await other.summaries.obliterate({ force: true });
        const keys = await other.connection.keys(`${prefix}-other:*`);
        if (keys.length) await other.connection.del(...keys);
        await other.close();
      }
    },
  );
});
