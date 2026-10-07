import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { fetchRemoteText } from "../src/network";
import { AppError } from "../src/errors";
import { db, redis, config, connect, disconnect } from "./helpers";

const scrapingConfig = {
  articleSelector: "article",
  titleSelector: "h2",
  linkSelector: "a",
  mode: "PAGINATE",
  pagination: { strategy: "QUERY_PARAM", queryParam: "page", startPage: 0 },
};
describe("source URL editing", () => {
  let userId = "";
  let sourceId = "";
  const requests: string[] = [];
  const app = createApp(db, redis, config, {
    rss: new RssService(async (url) => {
      requests.push(url);
      if (url.startsWith("http://127.")) return fetchRemoteText(url);
      if (url.includes("broken")) throw new AppError(502, "Flux inaccessible.", "NETWORK_ERROR");
      return "<rss><channel><item><title>Article</title><link>https://fixture.example/article</link></item></channel></rss>";
    }),
    scraping: new ScrapingService(async (url) => {
      requests.push(url);
      if (url.includes("broken")) throw new AppError(502, "Page inaccessible.", "NETWORK_ERROR");
      if (
        url.endsWith("/scroll") ||
        url.endsWith("/0") ||
        new URL(url).searchParams.get("page") === "0"
      )
        return '<article><h2>Article</h2><a href="/article">Lire</a><p>Description</p><time datetime="2026-10-07">7 octobre</time></article>';
      return "<main></main>";
    }),
  });
  const agent = request.agent(app);
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(async () => {
    const email = `edit-${randomUUID()}@example.com`;
    const user = await db.user.create({
      data: { email, passwordHash: await Bun.password.hash("Password123456") },
    });
    userId = user.id;
    const source = await db.source.create({
      data: { userId, type: "RSS", url: "https://fixture.example/feed", enabled: false },
    });
    sourceId = source.id;
    await agent.post("/auth/login").send({ email, password: "Password123456" });
    requests.length = 0;
  });
  afterEach(async () => {
    await db.user.delete({ where: { id: userId } });
  });
  const patch = (body: object) => agent.patch(`/sources/${sourceId}`).send(body);
  test("validates an RSS URL and updates the existing source without changing its history or disabled state", async () => {
    const article = await db.article.create({
      data: {
        userId,
        sourceId,
        title: "Article existant",
        fingerprint: randomUUID(),
        contentHash: randomUUID(),
        summary: "Résumé existant",
      },
    });
    expect((await patch({ url: "https://fixture.example/new-feed" })).status).toBe(204);
    expect(requests).toEqual(["https://fixture.example/new-feed"]);
    expect(await db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      id: sourceId,
      userId,
      type: "RSS",
      url: "https://fixture.example/new-feed",
      enabled: false,
      scrapingConfig: null,
    });
    expect(await db.source.count({ where: { userId } })).toBe(1);
    expect(await db.article.findUniqueOrThrow({ where: { id: article.id } })).toMatchObject({
      sourceId,
      summary: "Résumé existant",
    });
  });
  test("checks ownership before fetching and requires authentication", async () => {
    expect(
      (
        await request(app)
          .patch(`/sources/${sourceId}`)
          .send({ url: "https://fixture.example/new" })
      ).status,
    ).toBe(401);
    const other = await db.user.create({
      data: { email: `other-${randomUUID()}@example.com`, passwordHash: "unused" },
    });
    try {
      const otherSource = await db.source.create({
        data: { userId: other.id, type: "RSS", url: "https://fixture.example/other" },
      });
      expect(
        (
          await agent
            .patch(`/sources/${otherSource.id}`)
            .send({ url: "https://fixture.example/new" })
        ).status,
      ).toBe(404);
      expect(
        (await agent.patch("/sources/missing").send({ url: "https://fixture.example/new" })).status,
      ).toBe(404);
      expect(requests).toHaveLength(0);
      expect((await db.source.findUniqueOrThrow({ where: { id: otherSource.id } })).url).toBe(
        "https://fixture.example/other",
      );
    } finally {
      await db.user.delete({ where: { id: other.id } });
    }
  });
  test("rejects invalid edits, duplicates and inaccessible URLs without changing the source", async () => {
    for (const body of [
      {},
      { url: "invalid" },
      { url: "ftp://fixture.example/feed" },
      { url: "https://fixture.example/new", userId: "other" },
      { url: "https://fixture.example/new", type: "SCRAPING" },
      { urlTemplate: "https://fixture.example/{page}" },
    ])
      expect((await patch(body)).status).toBe(400);
    await db.source.create({ data: { userId, type: "RSS", url: "https://fixture.example/taken" } });
    expect((await patch({ url: "https://fixture.example/taken" })).status).toBe(409);
    expect(requests).toHaveLength(0);
    expect((await patch({ url: "https://fixture.example/broken", enabled: true })).status).toBe(
      502,
    );
    expect((await patch({ url: "http://127.0.0.1/private" })).body.code).toBe("UNSAFE_URL");
    expect(await db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      url: "https://fixture.example/feed",
      enabled: false,
    });
  });
  test("retains activation updates and treats an unchanged URL as a no-op", async () => {
    expect((await patch({ enabled: true })).status).toBe(204);
    expect((await patch({ url: "https://fixture.example/feed" })).status).toBe(204);
    expect(requests).toHaveLength(0);
    expect((await db.source.findUniqueOrThrow({ where: { id: sourceId } })).enabled).toBe(true);
  });
  test("rejects scraping settings on RSS and ambiguous template edits", async () => {
    expect((await patch({ scrapingConfig })).status).toBe(400);
    expect(
      (
        await patch({
          url: "https://fixture.example/new",
          scrapingConfig,
          urlTemplate: "https://fixture.example/{page}",
        })
      ).status,
    ).toBe(400);
    expect(requests).toHaveLength(0);
  });
  test("edits all scraping settings at the same URL, clears optional selectors and switches modes without losing history", async () => {
    await db.source.update({
      where: { id: sourceId },
      data: { type: "SCRAPING", url: "https://fixture.example/scroll", scrapingConfig },
    });
    const article = await db.article.create({
      data: {
        userId,
        sourceId,
        title: "Existant",
        summary: "Résumé conservé",
        fingerprint: randomUUID(),
        contentHash: randomUUID(),
      },
    });
    const scrollConfig = {
      articleSelector: "article",
      titleSelector: "h2:first-of-type",
      linkSelector: "a[href]",
      descriptionSelector: "p",
      dateSelector: "time",
      mode: "SCROLL",
      scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
    };
    expect((await patch({ scrapingConfig: scrollConfig })).status).toBe(204);
    expect(requests).toEqual(["https://fixture.example/scroll"]);
    expect((await db.source.findUniqueOrThrow({ where: { id: sourceId } })).scrapingConfig).toEqual(
      scrollConfig,
    );
    const paginationConfig = {
      ...scrapingConfig,
      pagination: {
        strategy: "URL_TEMPLATE",
        startPage: 0,
        urlTemplate: "https://fixture.example/pages/{page}",
      },
    };
    requests.length = 0;
    expect((await patch({ scrapingConfig: paginationConfig })).status).toBe(204);
    expect(requests).toEqual(["https://fixture.example/pages/0"]);
    expect(await db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      id: sourceId,
      enabled: false,
      scrapingConfig: paginationConfig,
    });
    expect((await db.article.findUniqueOrThrow({ where: { id: article.id } })).summary).toBe(
      "Résumé conservé",
    );
  }, 15000);
  test("invalid selectors or retrieval failures leave all existing scraping settings unchanged", async () => {
    await db.source.update({
      where: { id: sourceId },
      data: { type: "SCRAPING", url: "https://fixture.example/scroll", scrapingConfig },
    });
    for (const edited of [
      { ...scrapingConfig, titleSelector: "" },
      { ...scrapingConfig, pagination: { ...scrapingConfig.pagination, startPage: -1 } },
    ])
      expect((await patch({ scrapingConfig: edited })).status).toBe(400);
    expect(requests).toHaveLength(0);
    const failure = await patch({
      url: "https://fixture.example/broken",
      scrapingConfig: { ...scrapingConfig, titleSelector: "h2:first-of-type" },
      enabled: true,
    });
    expect(failure.status).toBe(502);
    expect(await db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      url: "https://fixture.example/scroll",
      enabled: false,
      scrapingConfig,
    });
  }, 15000);
  test("uses the saved scraping selectors and pagination at the new URL", async () => {
    await db.source.update({
      where: { id: sourceId },
      data: { type: "SCRAPING", url: "https://fixture.example/old-news", scrapingConfig },
    });
    expect((await patch({ url: "https://fixture.example/new-news" })).status).toBe(204);
    expect(requests).toEqual(["https://fixture.example/new-news?page=0"]);
    expect(await db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      url: "https://fixture.example/new-news",
      enabled: false,
      scrapingConfig,
    });
  }, 15000);
  test("updates the pagination template alongside its source URL and refuses a missing or invalid template", async () => {
    await db.source.update({
      where: { id: sourceId },
      data: {
        type: "SCRAPING",
        url: "https://fixture.example/old",
        scrapingConfig: {
          ...scrapingConfig,
          pagination: {
            strategy: "URL_TEMPLATE",
            startPage: 0,
            urlTemplate: "https://fixture.example/old/{page}",
          },
        },
      },
    });
    expect((await patch({ url: "https://fixture.example/new" })).status).toBe(400);
    expect(
      (
        await patch({
          url: "https://fixture.example/new",
          urlTemplate: "https://fixture.example/no-placeholder",
        })
      ).status,
    ).toBe(400);
    expect(requests).toHaveLength(0);
    expect(
      (
        await patch({
          url: "https://fixture.example/new",
          urlTemplate: "https://fixture.example/new/{page}",
        })
      ).status,
    ).toBe(204);
    expect(requests).toEqual(["https://fixture.example/new/0"]);
    const saved = await db.source.findUniqueOrThrow({ where: { id: sourceId } });
    expect(saved.scrapingConfig).toMatchObject({
      articleSelector: "article",
      titleSelector: "h2",
      pagination: { urlTemplate: "https://fixture.example/new/{page}" },
    });
    requests.length = 0;
    expect((await patch({ url: "https://fixture.example/new" })).status).toBe(204);
    expect(requests).toHaveLength(0);
  }, 15000);
});
