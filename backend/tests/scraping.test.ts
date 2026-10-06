import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { ScrapingConfig } from "@dailybrief/shared";
import { scrapingSchema } from "../../shared/src/scraping";
import { ScrapingService, paginationUrl } from "../src/scraping";
import { createApp } from "../src/app";
import { config, db, redis, connect, disconnect } from "./helpers";
const base = {
  articleSelector: "article",
  titleSelector: "h2",
  linkSelector: "a",
  descriptionSelector: "p",
  dateSelector: "time",
};
const scroll: ScrapingConfig = {
  ...base,
  mode: "SCROLL",
  scroll: { maxScrolls: 1, waitAfterScrollMs: 100 },
};
const paginate: ScrapingConfig = {
  ...base,
  mode: "PAGINATE",
  pagination: { strategy: "QUERY_PARAM", queryParam: "page", maxPages: 2, startPage: 1 },
};
const html = (id: string) =>
  `<article><h2>Article ${id}</h2><a href="/articles/${id}">Lire</a><p>Description</p><time datetime="2026-10-06">Date</time></article>`;
test("validates both modes and rejects incomplete/unbounded configurations", () => {
  expect(scrapingSchema.safeParse(scroll).success).toBe(true);
  expect(scrapingSchema.safeParse(paginate).success).toBe(true);
  for (const input of [
    { ...base, mode: "SCROLL" },
    { ...base, mode: "PAGINATE" },
    { ...scroll, scroll: { maxScrolls: 1000, waitAfterScrollMs: 1 } },
    {
      ...paginate,
      pagination: {
        strategy: "URL_TEMPLATE",
        maxPages: 2,
        startPage: 1,
        urlTemplate: "https://example.com",
      },
    },
  ])
    expect(scrapingSchema.safeParse(input).success).toBe(false);
});
test("generates query and template pagination URLs", () => {
  expect(paginationUrl("https://example.com/items", paginate, 2)).toBe(
    "https://example.com/items?page=2",
  );
  expect(
    paginationUrl(
      "https://example.com",
      {
        ...paginate,
        pagination: {
          strategy: "URL_TEMPLATE",
          urlTemplate: "https://example.com/{page}",
          startPage: 1,
          maxPages: 2,
        },
      },
      3,
    ),
  ).toBe("https://example.com/3");
});
test("browser extracts and deduplicates relative links across bounded pages", async () => {
  const requests: string[] = [];
  const service = new ScrapingService(async (url) => {
    requests.push(url);
    return html("common") + html(new URL(url).searchParams.get("page")!);
  });
  const result = await service.collect("https://fixture.example/items", paginate);
  expect(requests).toHaveLength(2);
  expect(result.articles).toHaveLength(3);
  expect(result.articles[0]).toMatchObject({
    title: "Article common",
    url: "https://fixture.example/articles/common",
    description: "Description",
    publishedAt: "2026-10-06T00:00:00.000Z",
  });
}, 15000);
test("browser stops pagination on an empty page and supports URL templates", async () => {
  const requests: string[] = [];
  const service = new ScrapingService(async (url) => {
    requests.push(url);
    return url.endsWith("/1") ? html("1") : "<p>Fin</p>";
  });
  const result = await service.collect("https://fixture.example", {
    ...paginate,
    pagination: {
      strategy: "URL_TEMPLATE",
      urlTemplate: "https://fixture.example/{page}",
      startPage: 1,
      maxPages: 5,
    },
  });
  expect(requests).toHaveLength(2);
  expect(result.articles).toHaveLength(1);
}, 15000);
test("browser performs bounded dynamic scrolling and merges snapshots", async () => {
  const service = new ScrapingService(
    async () =>
      `<body style="min-height:5000px">${html("first")}<script>window.addEventListener('scroll',()=>{if(!document.querySelector('#new')){const el=document.createElement('article');el.id='new';el.innerHTML='<h2>New</h2><a href="/new">Read</a>';document.body.append(el);}})</script></body>`,
  );
  const result = await service.collect("https://fixture.example", scroll);
  expect(result.articles.map((item) => item.title)).toContain("New");
  expect(result.articles).toHaveLength(2);
}, 15000);
test("rejects invalid selectors and empty extraction without leaking internals", async () => {
  const service = new ScrapingService(async () => html("1"));
  await expect(
    service.collect("https://fixture.example", { ...scroll, articleSelector: "??" }),
  ).rejects.toThrow("Impossible d'extraire");
}, 15000);
test("rejects empty extraction", async () => {
  const service = new ScrapingService(async () => html("1"));
  await expect(
    service.collect("https://fixture.example", { ...scroll, titleSelector: ".missing" }),
  ).rejects.toThrow("Aucun article");
}, 15000);
describe("scraping source routes", () => {
  const email = `scrape-${randomUUID()}@example.com`;
  let userId = "";
  const app = createApp(db, redis, config, {
    scraping: new ScrapingService(async () => html("1")),
  });
  const agent = request.agent(app);
  beforeAll(async () => {
    await connect();
    const user = await db.user.create({
      data: { email, passwordHash: await Bun.password.hash("Password123456") },
    });
    userId = user.id;
    await agent.post("/auth/login").send({ email, password: "Password123456" });
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { email } });
    await disconnect();
  });
  test("requires authentication and rejects userId spoofing", async () => {
    expect(
      (
        await request(app)
          .post("/sources/scraping/test")
          .send({ url: "https://fixture.example", config: scroll })
      ).status,
    ).toBe(401);
    expect(
      (
        await agent.post("/sources").send({
          url: "https://fixture.example",
          type: "SCRAPING",
          scrapingConfig: scroll,
          userId: "other",
        })
      ).status,
    ).toBe(400);
  });
  test("previews without persistence then stores typed configuration", async () => {
    const response = await agent
      .post("/sources/scraping/test")
      .send({ url: "https://fixture.example", config: scroll });
    expect(response.status).toBe(200);
    expect(await db.source.count({ where: { userId } })).toBe(0);
    const saved = await agent
      .post("/sources")
      .send({ url: "https://fixture.example", type: "SCRAPING", scrapingConfig: scroll });
    expect(saved.status).toBe(201);
    expect(saved.body.userId).toBe(userId);
    expect(saved.body.scrapingConfig.mode).toBe("SCROLL");
  }, 15000);
});
