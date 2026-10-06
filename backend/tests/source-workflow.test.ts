import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { WorkflowPreview } from "@dailybrief/shared";
import { createApp } from "../src/app";
import { ArticleContentService } from "../src/article-content";
import { RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { AppError } from "../src/errors";
import { config, db, redis, connect, disconnect } from "./helpers";

describe("source workflow tests", () => {
  let userId = "";
  let sourceId = "";
  let feedRequests = 0;
  let pageRequests: string[] = [];
  let summaries = 0;
  let emails = 0;
  let failPage = false;
  let failAi = false;
  let privatePage = false;
  const previews: WorkflowPreview[] = [];
  const fullText =
    "Cette information détaillée provient de la page complète et ne figure pas dans la description RSS. ".repeat(
      10,
    );
  const app = createApp(db, redis, config, {
    rss: new RssService(async () => {
      feedRequests++;
      return `<rss><channel><item><title>Déjà livré</title><link>${privatePage ? "http://127.0.0.1/private" : "https://example.com/one"}</link><description>Extrait court</description></item><item><title>Nouveau</title><link>https://example.com/two</link></item><item><title>Sans lien</title></item></channel></rss>`;
    }),
    scraping: new ScrapingService(
      async () =>
        `<article><h2>Article scraping</h2><a href="/scraped">Lire</a><p>Extrait court</p></article>`,
    ),
    articleContent: new ArticleContentService(async (url) => {
      pageRequests.push(url);
      if (failPage) throw new AppError(502, "Page inaccessible.", "NETWORK_ERROR");
      // Preserve the real transport guard for the malicious-link test.
      if (url.startsWith("http://127.")) return new ArticleContentService().fetch(url);
      return `<article><h1>Article</h1><p>${fullText}</p></article>`;
    }),
    summary: {
      summarize: async (input, observer) => {
        summaries++;
        expect(input.content).toContain(fullText.trim());
        expect(input.content).not.toBe("Extrait court");
        if (failAi) throw new AppError(503, "Ollama inaccessible.", "AI_UNAVAILABLE");
        observer?.("Résumé de la portion 1/1.");
        return {
          title: input.title,
          summary: "Résumé de la page complète.",
          keyPoints: ["Détails de la page."],
        };
      },
    },
    email: {
      send: async () => {
        emails++;
        throw new Error("Workflow tests must never send mail");
      },
    },
  });
  const agent = request.agent(app);
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(async () => {
    const email = `workflow-${randomUUID()}@example.com`;
    const user = await db.user.create({
      data: { email, passwordHash: await Bun.password.hash("Password123456") },
    });
    userId = user.id;
    sourceId = (
      await db.source.create({
        data: { userId, type: "RSS", url: "https://example.com/feed", enabled: false },
      })
    ).id;
    const article = await db.article.create({
      data: {
        userId,
        sourceId,
        title: "Déjà livré",
        url: "https://example.com/one",
        canonicalUrl: "https://example.com/one",
        fingerprint: randomUUID(),
        contentHash: randomUUID(),
        content: "Texte déjà enregistré",
        contentFetchedAt: new Date(),
        summary: "Résumé déjà enregistré",
        summaryTitle: "Titre enregistré",
        keyPoints: ["Point existant"],
        summarizedAt: new Date(),
      },
    });
    await db.newsletter.create({
      data: {
        userId,
        recipientEmail: email,
        subject: "Déjà envoyé",
        status: "SENT",
        articles: { create: { articleId: article.id } },
      },
    });
    await agent.post("/auth/login").send({ email, password: "Password123456" });
    feedRequests = summaries = emails = 0;
    pageRequests = [];
    failPage = failAi = privatePage = false;
    previews.length = 0;
  });
  afterEach(async () => {
    for (const preview of previews)
      await redis.del(`dailybrief:workflow:${userId}:${sourceId}:${preview.id}`);
    await db.user.delete({ where: { id: userId } });
  });
  async function collect() {
    const result = await agent.post(`/sources/${sourceId}/workflow`).send({});
    expect(result.status).toBe(200);
    const preview = result.body as WorkflowPreview;
    previews.push(preview);
    return preview;
  }
  function summarize(preview: WorkflowPreview, index = 0) {
    return agent
      .post(`/sources/${sourceId}/workflow/${preview.id}/articles/${index}/summarize`)
      .send({});
  }
  const events = (response: { text: string }) =>
    response.text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  test("retrieves every feed item freshly including disabled sources and already delivered articles", async () => {
    const first = await collect();
    expect(first.articles).toHaveLength(3);
    expect(first.articles[0]?.title).toBe("Déjà livré");
    const second = await collect();
    expect(second.id).not.toBe(first.id);
    expect(feedRequests).toBe(2);
    expect(pageRequests).toHaveLength(0);
    expect(summaries).toBe(0);
    expect(
      await redis.ttl(`dailybrief:workflow:${userId}:${sourceId}:${first.id}`),
    ).toBeGreaterThan(0);
    expect(await db.article.count({ where: { userId } })).toBe(1);
  });
  test("can repeatedly summarize a delivered article from its full page without touching production or email", async () => {
    const before = await db.article.findMany({ where: { userId } });
    const preview = await collect();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await summarize(preview);
      expect(response.headers["content-type"]).toContain("application/x-ndjson");
      const received = events(response);
      expect(received.some((event) => event.progress?.stage === "content")).toBe(true);
      expect(received.some((event) => event.progress?.message.includes("portion 1/1"))).toBe(true);
      expect(received.at(-1)).toMatchObject({
        type: "result",
        result: {
          content: expect.stringContaining(fullText.trim()),
          summary: { summary: "Résumé de la page complète." },
        },
      });
    }
    expect(pageRequests).toEqual(["https://example.com/one", "https://example.com/one"]);
    expect(summaries).toBe(2);
    expect(await db.article.findMany({ where: { userId } })).toEqual(before);
    expect(await db.dailyBriefRun.count({ where: { userId } })).toBe(0);
    expect(await db.newsletter.count({ where: { userId } })).toBe(1);
    expect(emails).toBe(0);
  });
  test("reports page and AI failures per article and allows a fresh retry", async () => {
    const preview = await collect();
    failPage = true;
    expect(events(await summarize(preview)).at(-1)).toMatchObject({
      type: "error",
      code: "NETWORK_ERROR",
    });
    expect(summaries).toBe(0);
    failPage = false;
    failAi = true;
    expect(events(await summarize(preview)).at(-1)).toMatchObject({
      type: "error",
      code: "AI_UNAVAILABLE",
    });
    failAi = false;
    expect(events(await summarize(preview)).at(-1)?.type).toBe("result");
    expect(emails).toBe(0);
  });
  test("requires session and ownership for collection and summarization", async () => {
    expect((await request(app).post(`/sources/${sourceId}/workflow`).send({})).status).toBe(401);
    const preview = await collect();
    const other = await db.user.create({
      data: { email: `other-${randomUUID()}@example.com`, passwordHash: "unused" },
    });
    try {
      const otherSource = await db.source.create({
        data: { userId: other.id, type: "RSS", url: "https://example.com/private" },
      });
      expect((await agent.post(`/sources/${otherSource.id}/workflow`).send({})).status).toBe(404);
      expect(
        (
          await agent
            .post(`/sources/${otherSource.id}/workflow/${preview.id}/articles/0/summarize`)
            .send({})
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .post(`/sources/${sourceId}/workflow/${preview.id}/articles/0/summarize`)
            .send({})
        ).status,
      ).toBe(401);
    } finally {
      await db.user.delete({ where: { id: other.id } });
    }
  });
  test("rejects expired previews, invalid indices and client-supplied replacement URLs", async () => {
    const preview = await collect();
    const path = `/sources/${sourceId}/workflow/${preview.id}/articles/0/summarize`;
    expect((await agent.post(path).send({ url: "https://attacker.example" })).status).toBe(400);
    expect((await summarize(preview, 99)).status).toBe(404);
    expect(events(await summarize(preview, 2)).at(-1)).toMatchObject({
      code: "ARTICLE_URL_MISSING",
    });
    await redis.del(`dailybrief:workflow:${userId}:${sourceId}:${preview.id}`);
    expect((await summarize(preview)).status).toBe(410);
    expect(summaries).toBe(0);
  });
  test("blocks private addresses supplied by a feed before calling AI", async () => {
    privatePage = true;
    const preview = await collect();
    expect(events(await summarize(preview)).at(-1)).toMatchObject({
      type: "error",
      code: "UNSAFE_URL",
    });
    expect(summaries).toBe(0);
  });
  test("supports the saved scraping configuration and its linked article", async () => {
    await db.source.update({
      where: { id: sourceId },
      data: {
        type: "SCRAPING",
        scrapingConfig: {
          articleSelector: "article",
          titleSelector: "h2",
          linkSelector: "a",
          descriptionSelector: "p",
          mode: "SCROLL",
          scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
        },
      },
    });
    const preview = await collect();
    expect(preview.source.type).toBe("SCRAPING");
    expect(preview.articles[0]?.title).toBe("Article scraping");
    expect(events(await summarize(preview)).at(-1)?.type).toBe("result");
    expect(pageRequests).toEqual(["https://example.com/scraped"]);
  });
});
