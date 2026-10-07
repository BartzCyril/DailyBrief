import { AppError } from "../src/errors";
import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import request from "supertest";
import nodemailer from "nodemailer";
import type { ArticlePreview, SourcePreview, CollectionProgress } from "@dailybrief/shared";
import { DailyBriefPipelineService } from "../src/pipeline";
import { SourceCollector } from "../src/collection";
import { RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { UserCollectionLock } from "../src/lock";
import { articleIdentity, canonicalUrl } from "../src/fingerprint";
import { renderNewsletter } from "../src/newsletter-template";
import { NewsletterEmailService, type NewsletterMessage } from "../src/email";
import { createApp } from "../src/app";
import { runDueCollections } from "../src/scheduler";
import { ArticleContentService } from "../src/article-content";
import { config, db, redis, connect, disconnect } from "./helpers";
const article = (id: string): ArticlePreview => ({
  title: `Titre ${id}`,
  url: `https://example.com/${id}`,
  guid: id,
  description: `Description ${id}`,
  content: `Information ${id}`,
  publishedAt: null,
});
test("fingerprints are deterministic and normalize tracking", () => {
  const item = { ...article("one"), sourceId: "source1" };
  expect(articleIdentity(item).fingerprint).toBe(articleIdentity(item).fingerprint);
  expect(canonicalUrl("https://example.com/a?utm_source=x&b=2&a=1#section")).toBe(
    "https://example.com/a?a=1&b=2",
  );
});
test("templates render escaped HTML, plain text, links and local dates", () => {
  const result = renderNewsletter(
    [
      {
        title: '<script>alert("x")</script>',
        summary: "Résumé & détails",
        keyPoints: ["Point <1>"],
        url: "javascript:alert(1)",
        source: "RSS",
        publishedAt: null,
      },
    ],
    "Europe/Paris",
    new Date("2026-10-06T23:00Z"),
  );
  expect(result.html).not.toContain("<script>");
  expect(result.html).not.toContain("javascript:");
  expect(result.html).toContain("&lt;script&gt;");
  expect(result.text).toContain("Point <1>");
  expect(result.subject).toContain("7 octobre 2026");
});
test("Nodemailer service uses account recipient and includes both bodies", async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const spy = spyOn(transport, "sendMail");
  await new NewsletterEmailService(config, transport).send({
    to: "account@example.com",
    newsletterId: "test",
    subject: "Test",
    html: "<p>Test</p>",
    text: "Test",
  });
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "account@example.com",
      html: "<p>Test</p>",
      text: "Test",
      disableFileAccess: true,
    }),
  );
  spy.mockRestore();
});
test("SMTP timeouts after DATA are reported as uncertain, explicit rejection as failed", async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const spy = spyOn(transport, "sendMail");
  const sender = new NewsletterEmailService(config, transport);
  const message = {
    to: "account@example.com",
    newsletterId: "test",
    subject: "Test",
    html: "Test",
    text: "Test",
  };
  spy.mockImplementation(() => {
    throw Object.assign(new Error("Connection lost"), { command: "DATA" });
  });
  await expect(sender.send(message)).rejects.toMatchObject({ code: "SMTP_UNCERTAIN" });
  spy.mockImplementation(() => {
    throw Object.assign(new Error("Rejected"), { command: "DATA", responseCode: 550 });
  });
  await expect(sender.send(message)).rejects.toMatchObject({ code: "SMTP_FAILED" });
  spy.mockRestore();
});
describe("DailyBrief pipeline", () => {
  let userId = "";
  let email = "";
  let sourceId = "";
  let rssArticles: ArticlePreview[] = [];
  let scrapedArticles: ArticlePreview[] = [];
  let sends: NewsletterMessage[] = [];
  let summaries = 0;
  let failEmail = false;
  let uncertainEmail = false;
  let failSummary = false;
  let summaryError: AppError | undefined;
  let sourceError = false;
  let waitForSummary: Promise<void> | undefined;
  let pageFetches: string[] = [];
  let failContent = false;
  let followDocument = false;
  let summaryUrls: Array<string | null | undefined> = [];
  let summaryInputs: string[] = [];
  class FixtureRss extends RssService {
    override async collect(): Promise<SourcePreview> {
      if (sourceError) throw new AppError(502, "Le flux est inaccessible.", "NETWORK_ERROR");
      return { articles: rssArticles };
    }
  }
  class FixtureScraper extends ScrapingService {
    override async collect(): Promise<SourcePreview> {
      return { articles: scrapedArticles };
    }
  }
  const collector = new SourceCollector(db, new FixtureRss(), new FixtureScraper());
  const runner = new DailyBriefPipelineService(
    db,
    collector,
    new UserCollectionLock(redis),
    {
      summarize: async (input) => {
        summaries++;
        summaryInputs.push(input.content);
        summaryUrls.push(input.url);
        await waitForSummary;
        if (summaryError) throw summaryError;
        if (failSummary && input.title.includes("two")) throw new Error("AI offline");
        return { title: input.title, summary: `Résumé ${input.content}`, keyPoints: ["Point clé"] };
      },
    },
    {
      send: async (message) => {
        if (uncertainEmail) throw new AppError(502, "Uncertain", "SMTP_UNCERTAIN");
        if (failEmail) throw new Error("SMTP offline");
        sends.push(message);
      },
    },
    new ArticleContentService(async (url) => {
      pageFetches.push(url);
      if (followDocument && url === "https://example.com/one")
        return '<article><p>Notice à ne pas résumer</p><a class="primarydoc" href="https://publisher.example/document">Consulter le document</a></article>';
      if (failContent && url.endsWith("one"))
        throw new AppError(502, "Page indisponible.", "NETWORK_ERROR");
      return `<html><body><article><h1>Texte complet</h1><p>${"Les détails du texte complet sont absents du flux. ".repeat(12)} Fin de l'article ${url}.</p></article></body></html>`;
    }),
  );
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(async () => {
    email = `pipeline-${randomUUID()}@example.com`;
    const user = await db.user.create({
      data: {
        email,
        passwordHash: await Bun.password.hash("Password123456"),
        settings: { create: {} },
      },
    });
    userId = user.id;
    sourceId = (
      await db.source.create({ data: { userId, type: "RSS", url: "https://example.com/feed" } })
    ).id;
    await db.source.create({
      data: {
        userId,
        type: "SCRAPING",
        url: "https://example.com/page",
        scrapingConfig: {
          articleSelector: "article",
          titleSelector: "h2",
          linkSelector: "a",
          mode: "SCROLL",
          scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
        },
      },
    });
    rssArticles = [article("one")];
    scrapedArticles = [article("two")];
    sends = [];
    summaries = 0;
    failEmail = false;
    uncertainEmail = false;
    failSummary = false;
    summaryError = undefined;
    sourceError = false;
    waitForSummary = undefined;
    pageFetches = [];
    summaryInputs = [];
    failContent = false;
    followDocument = false;
    summaryUrls = [];
  });
  afterEach(async () => {
    await db.user.delete({ where: { id: userId } });
  });

  test("uses the RSS document link for AI and newsletter while retaining notice identity", async () => {
    followDocument = true;
    await db.source.update({
      where: { id: sourceId },
      data: { articleLinkSelector: "a.primarydoc" },
    });
    const result = await runner.run(userId);
    expect(result.status).toBe("SENT");
    const saved = await db.article.findFirstOrThrow({ where: { sourceId } });
    expect(saved).toMatchObject({
      url: "https://example.com/one",
      canonicalUrl: "https://example.com/one",
      contentUrl: "https://publisher.example/document",
      contentLinkSelector: "a.primarydoc",
    });
    expect(saved.content).not.toContain("Notice à ne pas résumer");
    expect(summaryUrls).toContain("https://publisher.example/document");
    expect(sends[0]?.html).toContain('href="https://publisher.example/document"');
  });
  test("refetches and regenerates only pending RSS content when its document selector changes", async () => {
    failEmail = true;
    expect((await runner.run(userId)).status).toBe("FAILED");
    const initial = await db.article.findFirstOrThrow({ where: { sourceId } });
    expect(initial.contentFetchedAt).not.toBeNull();
    expect(initial.contentLinkSelector).toBeNull();
    expect(summaries).toBe(2);
    followDocument = true;
    failEmail = false;
    await db.source.update({
      where: { id: sourceId },
      data: { articleLinkSelector: "a.primarydoc" },
    });
    pageFetches = [];
    const result = await runner.run(userId);
    expect(result.status).toBe("SENT");
    expect(result.newArticles).toBe(0);
    expect(result.articlesSummarized).toBe(1);
    expect(pageFetches).toEqual(["https://example.com/one", "https://publisher.example/document"]);
    expect(summaries).toBe(3);
    expect((await db.article.findUniqueOrThrow({ where: { id: initial.id } })).contentUrl).toBe(
      "https://publisher.example/document",
    );
  });
  test("collects both providers, persists summaries, newsletter and run history", async () => {
    const result = await runner.run(userId);
    expect(result).toMatchObject({
      status: "SENT",
      sourcesProcessed: 2,
      newArticles: 2,
      articlesSummarized: 2,
      emailSent: true,
    });
    expect(sends[0]?.to).toBe(email);
    expect(pageFetches).toHaveLength(2);
    expect(summaryInputs.every((content) => content.includes("Les détails du texte complet"))).toBe(
      true,
    );
    expect(
      (await db.article.findFirstOrThrow({ where: { userId } })).contentFetchedAt,
    ).not.toBeNull();
    expect(await db.article.count({ where: { userId, summarizedAt: { not: null } } })).toBe(2);
    expect(await db.newsletterArticle.count({ where: { newsletterId: result.newsletterId } })).toBe(
      2,
    );
    expect(
      await db.dailyBriefRun.count({
        where: { userId, status: "SENT", finishedAt: { not: null } },
      }),
    ).toBe(1);
  });
  test("reruns exclude already sent articles and never send empty mail", async () => {
    await runner.run(userId);
    const next = await runner.run(userId);
    expect(next.status).toBe("NO_NEW_ARTICLES");
    expect(next.newArticles).toBe(0);
    expect(summaries).toBe(2);
    expect(sends).toHaveLength(1);
    expect(pageFetches).toHaveLength(2);
  });
  test("GUID dedup survives URL changes", async () => {
    scrapedArticles = [];
    await runner.run(userId);
    rssArticles = [
      { ...article("one"), url: "https://example.com/changed", content: "Changed text" },
    ];
    expect((await runner.run(userId)).newArticles).toBe(0);
    expect(summaries).toBe(1);
  });
  test("canonical URL dedup survives GUID changes and tracking", async () => {
    scrapedArticles = [];
    await runner.run(userId);
    rssArticles = [
      {
        ...article("one"),
        guid: "changed",
        url: "https://example.com/one?utm_source=next#top",
        content: "Updated",
      },
    ];
    expect((await runner.run(userId)).newArticles).toBe(0);
  });
  test("content hashes deduplicate copies across sources", async () => {
    scrapedArticles = [{ ...article("one"), url: null, guid: "another" }];
    const result = await runner.run(userId);
    expect(result.newArticles).toBe(1);
    expect(summaries).toBe(1);
  });
  test("SMTP failure preserves summaries and retries without recreating or resummarizing", async () => {
    failEmail = true;
    const first = await runner.run(userId);
    expect(first.status).toBe("FAILED");
    expect(first.emailSent).toBe(false);
    expect(first.failure).toMatchObject({
      stage: "email",
      message: expect.stringContaining("SMTP"),
    });
    expect(
      (await db.newsletter.findUniqueOrThrow({ where: { id: first.newsletterId! } })).status,
    ).toBe("FAILED");
    failEmail = false;
    const retry = await runner.run(userId);
    expect(retry.status).toBe("SENT");
    expect(retry.newArticles).toBe(0);
    expect(retry.articlesSummarized).toBe(0);
    expect(summaries).toBe(2);
    expect(sends).toHaveLength(1);
    expect(pageFetches).toHaveLength(2);
  });
  test("article download failures skip AI and delivery for that article, then retry its full page", async () => {
    failContent = true;
    const events: CollectionProgress[] = [];
    expect((await runner.run(userId, "manual", (event) => events.push(event))).status).toBe("SENT");
    const failed = await db.article.findFirstOrThrow({ where: { userId, title: "Titre one" } });
    expect(failed.contentError).toBe("Page indisponible.");
    expect(failed.contentFetchedAt).toBeNull();
    expect(failed.summary).toBeNull();
    expect(summaries).toBe(1);
    expect(sends[0]?.text).not.toContain("Titre one");
    expect(events.some((event) => event.stage === "content" && event.status === "failed")).toBe(
      true,
    );
    failContent = false;
    followDocument = false;
    summaryUrls = [];
    expect(await runner.run(userId)).toMatchObject({
      status: "SENT",
      newArticles: 0,
      articlesSummarized: 1,
    });
    expect(pageFetches.filter((url) => url.endsWith("one"))).toHaveLength(2);
    expect(
      (await db.article.findUniqueOrThrow({ where: { id: failed.id } })).contentError,
    ).toBeNull();
  });
  test("all page failures identify the content stage and never fall back to the feed teaser", async () => {
    scrapedArticles = [];
    failContent = true;
    expect(await runner.run(userId)).toMatchObject({
      status: "FAILED",
      failure: { stage: "content", code: "NETWORK_ERROR", message: "Page indisponible." },
    });
    expect(summaries).toBe(0);
    expect(sends).toHaveLength(0);
  });
  test("old undelivered summaries from feed excerpts are regenerated from the complete page", async () => {
    scrapedArticles = [];
    await db.article.create({
      data: {
        userId,
        sourceId,
        title: "Titre one",
        url: article("one").url,
        ...articleIdentity({ ...article("one"), sourceId }),
        content: "Ancien extrait",
        summary: "Ancien résumé",
        summarizedAt: new Date(),
        keyPoints: ["Ancien point"],
      },
    });
    expect(await runner.run(userId)).toMatchObject({
      status: "SENT",
      newArticles: 0,
      articlesSummarized: 1,
    });
    expect(pageFetches).toHaveLength(1);
    expect(sends[0]?.text).not.toContain("Ancien résumé");
    expect(sends[0]?.text).toContain("Les détails du texte complet");
  });
  test("isolates AI failures and retries only the unsummarized article", async () => {
    failSummary = true;
    expect((await runner.run(userId)).status).toBe("SENT");
    expect(sends[0]?.text).not.toContain("Titre two");
    failSummary = false;
    const next = await runner.run(userId);
    expect(next.articlesSummarized).toBe(1);
    expect(summaries).toBe(3);
    expect(sends).toHaveLength(2);
  });
  test("missing model is reported, saved in history and stops redundant AI requests", async () => {
    summaryError = new AppError(503, "Le modèle IA n'est pas installé.", "MODEL_MISSING");
    const events: CollectionProgress[] = [];
    const result = await runner.run(userId, "manual", (event) => events.push(event));
    expect(result).toMatchObject({
      status: "FAILED",
      articlesCollected: 2,
      newArticles: 2,
      failure: { stage: "ai", code: "MODEL_MISSING", message: "Le modèle IA n'est pas installé." },
    });
    expect(summaries).toBe(1);
    expect(sends).toHaveLength(0);
    expect((await db.dailyBriefRun.findFirstOrThrow({ where: { userId } })).error).toBe(
      result.failure!.message,
    );
    expect(events.some((event) => event.stage === "ai" && event.status === "failed")).toBe(true);
    summaryError = undefined;
    expect(await runner.run(userId)).toMatchObject({
      status: "SENT",
      newArticles: 0,
      articlesSummarized: 2,
    });
  });
  test("source failures identify the source stage without exposing URL parameters", async () => {
    sourceError = true;
    await db.source.updateMany({ where: { userId, type: "SCRAPING" }, data: { enabled: false } });
    await db.source.update({
      where: { id: sourceId },
      data: { url: "https://example.com/feed?key=secret" },
    });
    const events: CollectionProgress[] = [];
    const result = await runner.run(userId, "manual", (event) => events.push(event));
    expect(result.failure).toMatchObject({
      stage: "source",
      code: "SOURCE_COLLECTION_FAILED",
      message: "Le flux est inaccessible.",
    });
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(summaries).toBe(0);
    expect(sends).toHaveLength(0);
  });
  test("a failing progress subscriber cannot prevent delivery", async () => {
    expect(
      (
        await runner.run(userId, "manual", () => {
          throw new Error("Viewer disconnected");
        })
      ).status,
    ).toBe("SENT");
    expect(sends).toHaveLength(1);
  });
  test("streams collection and AI events before summaries finish, then reports SMTP and result", async () => {
    let release = () => {};
    waitForSummary = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp(db, redis, config, { runner });
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}`;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const login = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "Password123456" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      await login.text();
      const response = await fetch(`${base}/collection/run`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: "{}",
        signal: AbortSignal.timeout(10000),
      });
      expect(response.headers.get("content-type")).toContain("application/x-ndjson");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("Envoi à l'IA")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream ended before AI started");
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("articles récupérés");
      expect(received).toContain("Texte de l'article extrait et sauvegardé");
      expect(sends).toHaveLength(0);
      expect(received).not.toContain('"type":"result"');
      release();
      while (true) {
        const chunk = await reader.read();
        received += decoder.decode(chunk.value, { stream: !chunk.done });
        if (chunk.done) break;
      }
      const events = received
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(events.at(-1)).toMatchObject({
        type: "result",
        result: { status: "SENT", emailSent: true },
      });
      expect(
        events.some(
          (event) => event.progress?.stage === "email" && event.progress.status === "completed",
        ),
      ).toBe(true);
    } finally {
      release();
      await reader?.cancel().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("streaming requires authentication and reports a held lock without starting another run", async () => {
    const app = createApp(db, redis, config, { runner });
    expect(
      (await request(app).post("/collection/run").set("Accept", "application/x-ndjson").send({}))
        .status,
    ).toBe(401);
    const agent = request.agent(app);
    await agent.post("/auth/login").send({ email, password: "Password123456" });
    const key = `dailybrief:collection:user:${userId}`;
    await redis.set(key, "other", { PX: 10000 });
    try {
      const response = await agent
        .post("/collection/run")
        .set("Accept", "application/x-ndjson")
        .send({});
      expect(JSON.parse(response.text.trim())).toMatchObject({
        type: "error",
        message: expect.stringContaining("déjà en cours"),
      });
      expect(summaries).toBe(0);
    } finally {
      await redis.del(key);
    }
  });
  test("closing the live connection lets the existing pipeline finish exactly once", async () => {
    let release = () => {};
    waitForSummary = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completion: ReturnType<typeof runner.run> | undefined;
    const app = createApp(db, redis, config, {
      runner: {
        run: (...args) => {
          completion = runner.run(...args);
          return completion;
        },
      },
    });
    const login = await request(app)
      .post("/auth/login")
      .send({ email, password: "Password123456" });
    const cookie = String(login.headers["set-cookie"]![0]).split(";")[0]!;
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/collection/run`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: "{}",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("Envoi à l'IA")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Premature end of stream");
        received += decoder.decode(chunk.value, { stream: true });
      }
      controller.abort();
      await reader.cancel().catch(() => {});
      release();
      expect(await completion).toMatchObject({ status: "SENT", emailSent: true });
      expect(sends).toHaveLength(1);
      expect((await runner.run(userId)).status).toBe("NO_NEW_ARTICLES");
      expect(sends).toHaveLength(1);
    } finally {
      controller.abort();
      release();
      await completion?.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("manual route and scheduler invoke the same pipeline, recipient cannot be overridden", async () => {
    const app = createApp(db, redis, config, { runner });
    const agent = request.agent(app);
    await agent.post("/auth/login").send({ email, password: "Password123456" });
    expect(
      (await agent.post("/collection/run").send({ recipientEmail: "attacker@example.com" })).status,
    ).toBe(400);
    expect((await agent.post("/collection/run").send({})).body.status).toBe("SENT");
    await db.dailyBriefSettings.update({
      where: { userId },
      data: { collectionEnabled: true, nextCollectionAt: new Date(0) },
    });
    await runDueCollections(db, runner);
    expect(sends).toHaveLength(1);
    expect(await db.dailyBriefRun.count({ where: { userId } })).toBe(2);
  });
  test("Redis blocks a second pipeline for the same user", async () => {
    const key = `dailybrief:collection:user:${userId}`;
    await redis.set(key, "other", { PX: 10000 });
    await expect(runner.run(userId)).rejects.toThrow("déjà en cours");
    await redis.del(key);
  });
  test("uncertain SMTP delivery remains SENDING and is not retried automatically", async () => {
    uncertainEmail = true;
    const first = await runner.run(userId);
    expect(first.status).toBe("FAILED");
    expect(
      (await db.newsletter.findUniqueOrThrow({ where: { id: first.newsletterId! } })).status,
    ).toBe("SENDING");
    uncertainEmail = false;
    expect((await runner.run(userId)).status).toBe("NO_NEW_ARTICLES");
    expect(sends).toHaveLength(0);
  });
  test("a scheduled pipeline rechecks disabled settings before doing work", async () => {
    expect((await runner.run(userId, "scheduled")).status).toBe("NO_NEW_ARTICLES");
    expect(summaries).toBe(0);
    expect(sends).toHaveLength(0);
  });
  test("uncertain SENDING newsletters are excluded until reconciled", async () => {
    await runner.run(userId);
    await db.newsletter.updateMany({
      where: { userId },
      data: { status: "SENDING", sentAt: null },
    });
    expect((await runner.run(userId)).status).toBe("NO_NEW_ARTICLES");
    expect(sends).toHaveLength(1);
  });
});
