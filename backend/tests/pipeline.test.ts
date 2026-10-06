import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import nodemailer from "nodemailer";
import type { ArticlePreview, SourcePreview } from "@dailybrief/shared";
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
import { config, db, redis, connect, disconnect } from "./helpers";
const article = (id: string): ArticlePreview => ({ title: `Titre ${id}`, url: `https://example.com/${id}`, guid: id, description: `Description ${id}`, content: `Information ${id}`, publishedAt: null });
test("fingerprints are deterministic and normalize tracking", () => {
  const item = { ...article("one"), sourceId: "source1" };
  expect(articleIdentity(item).fingerprint).toBe(articleIdentity(item).fingerprint);
  expect(canonicalUrl("https://example.com/a?utm_source=x&b=2&a=1#section")).toBe("https://example.com/a?a=1&b=2");
});
test("templates render escaped HTML, plain text, links and local dates", () => {
  const result = renderNewsletter([{ title: '<script>alert("x")</script>', summary: "Résumé & détails", keyPoints: ["Point <1>"], url: "javascript:alert(1)", source: "RSS", publishedAt: null }], "Europe/Paris", new Date("2026-10-06T23:00Z"));
  expect(result.html).not.toContain("<script>"); expect(result.html).not.toContain("javascript:"); expect(result.html).toContain("&lt;script&gt;"); expect(result.text).toContain("Point <1>"); expect(result.subject).toContain("7 octobre 2026");
});
test("Nodemailer service uses account recipient and includes both bodies", async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true }); const spy = spyOn(transport, "sendMail");
  await new NewsletterEmailService(config, transport).send({ to: "account@example.com", newsletterId: "test", subject: "Test", html: "<p>Test</p>", text: "Test" });
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ to: "account@example.com", html: "<p>Test</p>", text: "Test", disableFileAccess: true })); spy.mockRestore();
});
describe("DailyBrief pipeline", () => {
  let userId = ""; let email = ""; let sourceId = ""; let rssArticles: ArticlePreview[] = []; let scrapedArticles: ArticlePreview[] = []; let sends: NewsletterMessage[] = []; let summaries = 0; let failEmail = false; let failSummary = false;
  class FixtureRss extends RssService { override async collect(): Promise<SourcePreview> { return { articles: rssArticles }; } }
  class FixtureScraper extends ScrapingService { override async collect(): Promise<SourcePreview> { return { articles: scrapedArticles }; } }
  const collector = new SourceCollector(db, new FixtureRss(), new FixtureScraper());
  const runner = new DailyBriefPipelineService(db, collector, new UserCollectionLock(redis), { summarize: async input => { summaries++; if (failSummary && input.title.includes("two")) throw new Error("AI offline"); return { title: input.title, summary: `Résumé ${input.content}`, keyPoints: ["Point clé"] }; } }, { send: async message => { if (failEmail) throw new Error("SMTP offline"); sends.push(message); } });
  beforeAll(connect); afterAll(disconnect);
  beforeEach(async () => {
    email = `pipeline-${randomUUID()}@example.com`; const user = await db.user.create({ data: { email, passwordHash: await Bun.password.hash("Password123456"), settings: { create: {} } } }); userId = user.id;
    sourceId = (await db.source.create({ data: { userId, type: "RSS", url: "https://example.com/feed" } })).id;
    await db.source.create({ data: { userId, type: "SCRAPING", url: "https://example.com/page", scrapingConfig: { articleSelector: "article", titleSelector: "h2", linkSelector: "a", mode: "SCROLL", scroll: { maxScrolls: 0, waitAfterScrollMs: 100 } } } });
    rssArticles = [article("one")]; scrapedArticles = [article("two")]; sends = []; summaries = 0; failEmail = false; failSummary = false;
  });
  afterEach(async () => { await db.user.delete({ where: { id: userId } }); });
  test("collects both providers, persists summaries, newsletter and run history", async () => {
    const result = await runner.run(userId); expect(result).toMatchObject({ status: "SENT", sourcesProcessed: 2, newArticles: 2, articlesSummarized: 2, emailSent: true }); expect(sends[0]?.to).toBe(email);
    expect(await db.article.count({ where: { userId, summarizedAt: { not: null } } })).toBe(2); expect(await db.newsletterArticle.count({ where: { newsletterId: result.newsletterId } })).toBe(2);
    expect(await db.dailyBriefRun.count({ where: { userId, status: "SENT", finishedAt: { not: null } } })).toBe(1);
  });
  test("reruns exclude already sent articles and never send empty mail", async () => {
    await runner.run(userId); const next = await runner.run(userId); expect(next.status).toBe("NO_NEW_ARTICLES"); expect(next.newArticles).toBe(0); expect(summaries).toBe(2); expect(sends).toHaveLength(1);
  });
  test("GUID dedup survives URL changes", async () => {
    scrapedArticles = []; await runner.run(userId); rssArticles = [{ ...article("one"), url: "https://example.com/changed", content: "Changed text" }];
    expect((await runner.run(userId)).newArticles).toBe(0); expect(summaries).toBe(1);
  });
  test("canonical URL dedup survives GUID changes and tracking", async () => {
    scrapedArticles = []; await runner.run(userId); rssArticles = [{ ...article("one"), guid: "changed", url: "https://example.com/one?utm_source=next#top", content: "Updated" }];
    expect((await runner.run(userId)).newArticles).toBe(0);
  });
  test("content hashes deduplicate copies across sources", async () => {
    scrapedArticles = [{ ...article("one"), url: null, guid: "another" }]; const result = await runner.run(userId); expect(result.newArticles).toBe(1); expect(summaries).toBe(1);
  });
  test("SMTP failure preserves summaries and retries without recreating or resummarizing", async () => {
    failEmail = true; const first = await runner.run(userId); expect(first.status).toBe("FAILED"); expect(first.emailSent).toBe(false);
    expect((await db.newsletter.findUniqueOrThrow({ where: { id: first.newsletterId! } })).status).toBe("FAILED");
    failEmail = false; const retry = await runner.run(userId); expect(retry.status).toBe("SENT"); expect(retry.newArticles).toBe(0); expect(retry.articlesSummarized).toBe(0); expect(summaries).toBe(2); expect(sends).toHaveLength(1);
  });
  test("isolates AI failures and retries only the unsummarized article", async () => {
    failSummary = true; expect((await runner.run(userId)).status).toBe("SENT"); expect(sends[0]?.text).not.toContain("Titre two");
    failSummary = false; const next = await runner.run(userId); expect(next.articlesSummarized).toBe(1); expect(summaries).toBe(3); expect(sends).toHaveLength(2);
  });
  test("manual route and scheduler invoke the same pipeline, recipient cannot be overridden", async () => {
    const app = createApp(db, redis, config, { runner }); const agent = request.agent(app); await agent.post("/auth/login").send({ email, password: "Password123456" });
    expect((await agent.post("/collection/run").send({ recipientEmail: "attacker@example.com" })).status).toBe(400);
    expect((await agent.post("/collection/run").send({})).body.status).toBe("SENT");
    await db.dailyBriefSettings.update({ where: { userId }, data: { collectionEnabled: true, nextCollectionAt: new Date(0) } });
    await runDueCollections(db, runner); expect(sends).toHaveLength(1); expect(await db.dailyBriefRun.count({ where: { userId } })).toBe(2);
  });
  test("Redis blocks a second pipeline for the same user", async () => {
    const key = `dailybrief:collection:user:${userId}`; await redis.set(key, "other", { PX: 10000 }); await expect(runner.run(userId)).rejects.toThrow("déjà en cours"); await redis.del(key);
  });
  test("uncertain SENDING newsletters are excluded until reconciled", async () => {
    await runner.run(userId); await db.newsletter.updateMany({ where: { userId }, data: { status: "SENDING", sentAt: null } }); expect((await runner.run(userId)).status).toBe("NO_NEW_ARTICLES"); expect(sends).toHaveLength(1);
  });
});
