import { afterAll, beforeAll, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { Browser } from "puppeteer";
import { scrapingBrowser } from "../src/browser";
import { config, db, redis, connect, disconnect } from "./helpers";
import { journalFixture, loginConfig, fullText } from "./fixtures/journal-login";
import { JournalLoginBrowser } from "../src/journal-login";
import { JournalAccessService, JournalSecretCipher } from "../src/journal-access";
import { ArticleContentService } from "../src/article-content";
import { SourceCollector } from "../src/collection";
import { RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { UserCollectionLock } from "../src/lock";
import {
  DailyBriefPipelineService,
  type ArticleDispatcher,
  type BriefDispatcher,
} from "../src/pipeline";
import { ScrapingSummaryProcessor } from "../src/queue/scraping-summary";
import { JobsManager } from "../src/queue/jobs-manager";
import { startConsumers } from "../src/queue/consumers";
import type { SummaryProvider } from "../src/ai";
import { AppError } from "../src/errors";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error("Journal batch did not finish");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("authenticated journal batches across sources and Redis consumers", () => {
  const prefix = `test-journal-batch-${randomUUID()}`;
  const queueConfig = {
    ...config,
    QUEUE_PREFIX: prefix,
    AI_CONCURRENCY: 2,
    COLLECTION_CONCURRENCY: 1,
  };
  const users: string[] = [];
  const fixture = journalFixture();
  const cipher = new JournalSecretCipher(randomBytes(32).toString("hex"));
  let manager: JobsManager;
  const consumers: Awaited<ReturnType<typeof startConsumers>>[] = [];
  let scenario = "success";
  let summaries = 0;
  let loginInAi = 0;
  let failAi = false;
  let transientAiFailures = 0;
  const browser = new JournalLoginBrowser(async (url, options) => {
    const path = new URL(url).pathname;
    if (scenario === "missing" && path === "/article-1")
      return { status: 404, cookies: [], text: "Article absent", contentType: "text/html" };
    if (scenario === "expired" && path === "/article-2") fixture.state.expired = true;
    return fixture.fetch(url, options);
  });
  const content = new ArticleContentService(async (url) => {
    if (!url.includes("notice.example")) throw new Error("No public journal download allowed");
    return `<a class="primarydoc" href="https://publisher.example/article-${new URL(url).pathname.split("/").at(-1)}">Lire</a>`;
  });
  const journals = new JournalAccessService(db, content, cipher, browser);
  class NoLoginInAi extends JournalLoginBrowser {
    override async run(): Promise<never> {
      loginInAi++;
      throw new Error("AI consumers must use prepared content");
    }
  }
  const provider: SummaryProvider = {
    async summarize(input) {
      summaries++;
      expect(input.content).toContain(fullText.trim());
      expect(input.content).not.toContain("journal-test-password");
      if (failAi) throw new AppError(503, "Modèle de test manquant.", "MODEL_MISSING");
      if (transientAiFailures-- > 0)
        throw new AppError(503, "IA de test temporairement indisponible.", "AI_UNAVAILABLE");
      return { title: input.title, summary: `Résumé ${input.title}`, keyPoints: ["Fait"] };
    },
    async generateBrief(input) {
      return {
        headline: "Veille",
        lead: "Les actualités",
        stories: [
          {
            title: "Les faits",
            text: "La synthèse",
            articleIds: input.articles.map((article) => article.id),
          },
        ],
        otherNews: [],
        trends: "",
      };
    },
  };
  const rss = new RssService(async (url) => {
    const id = new URL(url).pathname.split("/").at(-1)!;
    const articleUrl =
      id === "3"
        ? `https://${scenario === "domains" ? "second.publisher.example" : "publisher.example"}/article-3`
        : `https://notice.example/${id}`;
    return `<rss><channel><item><title>Article distinct ${id}</title><link>${articleUrl}</link><description>Description du sujet ${id}</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
  });
  class FixtureScraper extends ScrapingService {
    override async collect(url: string) {
      return rss.collect(url);
    }
  }
  const makePipeline = (dispatch?: ArticleDispatcher, finalize?: BriefDispatcher) =>
    new DailyBriefPipelineService(
      db,
      new SourceCollector(db, rss, new FixtureScraper(), content),
      new UserCollectionLock(redis),
      provider,
      { async send() {} },
      content,
      journals,
      dispatch,
      finalize,
    );
  async function owner(enabled = true, email = "reader@example.com", withScraping = false) {
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@batch.example`,
        passwordHash: "unused",
        settings: { create: { collectionEnabled: true, nextCollectionAt: new Date(0) } },
      },
    });
    users.push(user.id);
    await db.source.createMany({
      data: [1, 2, 3].map((id) => ({
        userId: user.id,
        url: `https://feed.example/${id}`,
        type: id === 3 && withScraping ? ("SCRAPING" as const) : ("RSS" as const),
        articleLinkSelector: id < 3 ? "a.primarydoc" : null,
        ...(id === 3 && withScraping
          ? {
              scrapingConfig: {
                articleSelector: "article",
                titleSelector: "h2",
                linkSelector: "a",
                descriptionSelector: "p",
                dateSelector: "time",
                mode: "SCROLL",
                scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
              },
            }
          : {}),
      })),
    });
    await db.journalAccess.create({
      data: {
        userId: user.id,
        domain: "publisher.example",
        enabled,
        email,
        encryptedPassword: cipher.encrypt("journal-test-password", user.id, "publisher.example"),
        ...loginConfig,
      },
    });
    return user;
  }
  async function execute(userId: string, trigger: "manual" | "scheduled" = "manual") {
    const run = await manager.enqueue(userId, trigger);
    const snapshot = await until(
      () => manager.snapshot(userId, run.id),
      (value) => !value.active,
    );
    return { snapshot, jobs: await manager.jobs(userId, run.id) };
  }
  beforeAll(async () => {
    await connect();
    manager = new JobsManager(db, queueConfig);
    // Separate service instances model independent consumers: no browser/cache is shared with the producer.
    for (let index = 0; index < 2; index++)
      consumers.push(
        await startConsumers(
          db,
          manager,
          makePipeline,
          new ScrapingSummaryProcessor(
            db,
            provider,
            content,
            new JournalAccessService(db, content, cipher, new NoLoginInAi()),
          ),
        ),
      );
  });
  beforeEach(() => {
    scenario = "success";
    summaries = loginInAi = 0;
    failAi = false;
    transientAiFailures = 0;
    fixture.requests.length = 0;
    fixture.state.failed = fixture.state.expired = false;
  });
  afterAll(async () => {
    for (const consumer of consumers) await consumer.close();
    await manager.collections.obliterate({ force: true });
    await manager.summaries.obliterate({ force: true });
    const keys = await manager.connection.keys(`${prefix}:*`);
    if (keys.length) await manager.connection.del(...keys);
    await manager.close();
    await db.user.deleteMany({ where: { id: { in: users } } });
    await disconnect();
  });

  test.each(["manual", "scheduled"] as const)(
    "%s: three sources use one login/browser and three AI jobs with no secrets in Redis",
    async (trigger) => {
      const user = await owner(true, "reader@example.com", trigger === "scheduled");
      const launch = spyOn(scrapingBrowser, "launch");
      try {
        const { snapshot, jobs } = await execute(user.id, trigger);
        expect(snapshot.result?.articlesSummarized).toBe(3);
        expect(jobs.total).toBe(3);
        expect(jobs.jobs.every((job) => job.state === "completed" && job.summary)).toBe(true);
        expect(
          jobs.jobs.every((job) =>
            job.articleUrl?.startsWith("https://publisher.example/article-"),
          ),
        ).toBe(true);
        expect(jobs.jobs.every((job) => job.articleUrl !== job.sourceUrl)).toBe(true);
        expect(summaries).toBe(3);
        expect(loginInAi).toBe(0);
        expect(launch).toHaveBeenCalledTimes(1);
        expect((await (launch.mock.results[0]!.value as Promise<Browser>)).isConnected()).toBe(
          false,
        );
        expect(
          fixture.requests.filter((request) => request.options?.method === "POST"),
        ).toHaveLength(1);
        expect(
          fixture.requests
            .filter((request) => request.url.includes("/article-"))
            .map((request) => request.options?.cookie),
        ).toEqual(Array(3).fill("sid=own-session"));
        const articles = await db.article.findMany({ where: { userId: user.id } });
        expect(
          articles.every(
            (article) =>
              article.contentFetchedAt &&
              article.contentAccessVersion &&
              article.content?.includes(fullText.trim()),
          ),
        ).toBe(true);
        const raw = JSON.stringify(
          (await manager.summaries.getJobs())
            .filter((job) => job.data.userId === user.id)
            .map((job) => ({ data: job.data, progress: job.progress })),
        );
        for (const secret of [
          "journal-test-password",
          "reader@example.com",
          "own-session",
          fullText.trim(),
        ])
          expect(raw).not.toContain(secret);
      } finally {
        launch.mockRestore();
      }
    },
    90000,
  );

  test("one unavailable article fails once while the other sources finish in the same session", async () => {
    scenario = "missing";
    const user = await owner();
    const { snapshot, jobs } = await execute(user.id);
    expect(snapshot.result?.articlesSummarized).toBe(2);
    expect(jobs.jobs.filter((job) => job.state === "failed")).toHaveLength(1);
    expect(jobs.jobs.filter((job) => job.state === "completed")).toHaveLength(2);
    expect(
      (await manager.summaries.getJobs(["failed"]))
        .filter((job) => job.data.userId === user.id)
        .map((job) => job.attemptsMade),
    ).toEqual([1]);
    expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
      1,
    );
    expect(loginInAi).toBe(0);
  }, 90000);

  test("expired session stops further navigation without reconnecting for the remaining jobs", async () => {
    scenario = "expired";
    const user = await owner();
    const { snapshot, jobs } = await execute(user.id);
    expect(snapshot.result?.articlesSummarized).toBe(1);
    expect(jobs.jobs.filter((job) => job.state === "failed")).toHaveLength(2);
    expect(fixture.requests.some((request) => request.url.endsWith("/article-3"))).toBe(false);
    expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
      1,
    );
    expect(loginInAi).toBe(0);
  }, 90000);

  test("login failure produces three failed jobs without another login or AI request", async () => {
    fixture.state.failed = true;
    const user = await owner();
    // Use automatic verification with a short deadline for this deliberately rejected form.
    await db.journalAccess.updateMany({
      where: { userId: user.id },
      data: { successSelector: null },
    });
    const shortBrowser = new JournalLoginBrowser(fixture.fetch, 2500);
    const session = spyOn(browser, "withSession").mockImplementation(
      shortBrowser.withSession.bind(shortBrowser),
    );
    try {
      const { jobs } = await execute(user.id);
      expect(jobs.jobs.every((job) => job.state === "failed")).toBe(true);
      expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
        1,
      );
      expect(summaries).toBe(0);
      expect(loginInAi).toBe(0);
    } finally {
      session.mockRestore();
    }
  }, 90000);

  test("disabled journals create skipped jobs without launching a browser or calling AI", async () => {
    const user = await owner(false);
    const launch = spyOn(scrapingBrowser, "launch");
    try {
      const { jobs } = await execute(user.id);
      expect(jobs.total).toBe(3);
      expect(jobs.jobs.every((job) => job.state === "completed" && job.skipped)).toBe(true);
      expect(jobs.jobs.every((job) => job.skipReason?.includes("désactivé"))).toBe(true);
      expect(jobs.jobs.every((job) => job.relevanceReason === null)).toBe(true);
      expect(launch).not.toHaveBeenCalled();
      expect(summaries).toBe(0);
      expect(loginInAi).toBe(0);
    } finally {
      launch.mockRestore();
    }
  }, 30000);

  test("another user's execution authenticates in a fresh context with their own cookies", async () => {
    const user = await owner(true, "other@example.com");
    await execute(user.id);
    expect(
      fixture.requests
        .filter((request) => request.url.endsWith("/login"))
        .every((request) => !request.options?.cookie),
    ).toBe(true);
    expect(
      fixture.requests
        .filter((request) => request.url.includes("/article-"))
        .map((request) => request.options?.cookie),
    ).toEqual(Array(3).fill("sid=other-session"));
    expect(loginInAi).toBe(0);
  }, 90000);

  test.each(["access", "source", "content"])(
    "changing %s after preparation blocks AI without opening another browser",
    async (change) => {
      const user = await owner();
      const pipeline = makePipeline(async (userId, _runId, ids, observer, prepared) => {
        if (change === "access")
          await db.journalAccess.updateMany({
            where: { userId },
            data: { email: "changed@example.com" },
          });
        if (change === "source")
          await db.source.updateMany({
            where: { userId },
            data: { updatedAt: new Date(Date.now() + 1000) },
          });
        if (change === "content")
          await db.article.updateMany({ where: { userId }, data: { contentFetchedAt: null } });
        const processor = new ScrapingSummaryProcessor(db, provider, content, journals);
        return Promise.all(
          ids.map((id) =>
            processor.run(userId, id, observer, undefined, undefined, undefined, {
              authenticatedPreparation: prepared?.[id],
              requirePreparedAuthentication: true,
            }),
          ),
        );
      });
      const result = await pipeline.run(user.id);
      expect(result.failure?.code).toBe(
        change === "access"
          ? "JOURNAL_ACCESS_CHANGED"
          : change === "source"
            ? "SOURCE_CHANGED"
            : "JOURNAL_PREPARATION_INVALID",
      );
      expect(summaries).toBe(0);
      expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
        1,
      );
    },
    90000,
  );

  test("AI retry uses saved content without reconnecting to the journal", async () => {
    transientAiFailures = 1;
    const user = await owner();
    const { snapshot, jobs } = await execute(user.id);
    expect(snapshot.result?.articlesSummarized).toBe(3);
    expect(jobs.jobs.some((job) => job.attempts === 2)).toBe(true);
    expect(summaries).toBe(4);
    expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
      1,
    );
    expect(loginInAi).toBe(0);
  }, 90000);

  test("a new execution reuses already prepared contents after AI failed without a new login", async () => {
    const user = await owner();
    failAi = true;
    await execute(user.id);
    failAi = false;
    summaries = 0;
    const launch = spyOn(scrapingBrowser, "launch");
    try {
      const { snapshot } = await execute(user.id);
      expect(snapshot.result?.articlesSummarized).toBe(3);
      expect(summaries).toBe(3);
      expect(launch).not.toHaveBeenCalled();
      expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
        1,
      );
      expect(loginInAi).toBe(0);
    } finally {
      launch.mockRestore();
    }
  }, 90000);

  test("different journal hosts use separate browsers and cookies within one execution", async () => {
    scenario = "domains";
    const user = await owner();
    await db.journalAccess.create({
      data: {
        userId: user.id,
        domain: "second.publisher.example",
        enabled: true,
        email: "other@example.com",
        encryptedPassword: cipher.encrypt(
          "journal-test-password",
          user.id,
          "second.publisher.example",
        ),
        ...loginConfig,
        loginUrl: "https://second.publisher.example/login",
      },
    });
    const launch = spyOn(scrapingBrowser, "launch");
    try {
      const { snapshot } = await execute(user.id);
      expect(snapshot.result?.articlesSummarized).toBe(3);
      expect(launch).toHaveBeenCalledTimes(2);
      expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
        2,
      );
      expect(
        fixture.requests
          .filter((request) => request.url.includes("/article-"))
          .map((request) => request.options?.cookie),
      ).toEqual(["sid=own-session", "sid=own-session", "sid=other-session"]);
      expect(loginInAi).toBe(0);
    } finally {
      launch.mockRestore();
    }
  }, 90000);

  test("a consumer cannot start a new authenticated session when batch preparation is missing", async () => {
    const user = await owner();
    const source = await db.source.findFirstOrThrow({
      where: { userId: user.id, articleLinkSelector: null },
    });
    const article = await db.article.create({
      data: {
        userId: user.id,
        sourceId: source.id,
        title: "Article sans préparation",
        url: "https://publisher.example/article",
        publishedAt: new Date(),
        contentHash: randomUUID(),
        fingerprint: randomUUID(),
      },
    });
    const processor = new ScrapingSummaryProcessor(
      db,
      provider,
      content,
      new JournalAccessService(db, content, cipher, new NoLoginInAi()),
    );
    const outcome = await processor.run(
      user.id,
      article.id,
      undefined,
      undefined,
      undefined,
      undefined,
      { requirePreparedAuthentication: true },
    );
    expect(outcome.failure?.code).toBe("JOURNAL_PREPARATION_INVALID");
    expect(summaries).toBe(0);
    expect(loginInAi).toBe(0);
    expect(fixture.requests).toHaveLength(0);
  });
});
