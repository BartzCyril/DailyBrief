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
  pagination: { strategy: "QUERY_PARAM", queryParam: "page", startPage: 1 },
};
const html = (id: string) =>
  `<article><h2>Article ${id}</h2><a href="/articles/${id}">Lire</a><p>Description</p><time datetime="2026-10-06">Date</time></article>`;
test("validates both modes and rejects incomplete configurations", () => {
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
        },
      },
      3,
    ),
  ).toBe("https://example.com/3");
});
test("ignores legacy page caps and allows page zero", () => {
  const legacy = scrapingSchema.parse({
    ...paginate,
    pagination: { ...paginate.pagination, startPage: 0, maxPages: 15 },
  });
  expect(legacy.pagination).not.toHaveProperty("maxPages");
  expect(paginationUrl("https://example.com/items", legacy, 0)).toBe(
    "https://example.com/items?page=0",
  );
});
test("collects more than fifteen pages until the first empty page", async () => {
  const pages: number[] = [];
  const service = new ScrapingService(async (url) => {
    const number = Number(new URL(url).searchParams.get("page"));
    pages.push(number);
    return number <= 16 ? html(String(number)) : "<main></main>";
  });
  const result = await service.collect("https://fixture.example/items", paginate);
  expect(pages).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
  expect(result.articles).toHaveLength(16);
  expect(result.articles.at(-1)?.title).toBe("Article 16");
}, 30000);
test("keeps every item on pages exceeding 200 items and a collection exceeding 500", async () => {
  const legacy = { ...paginate, pagination: { ...paginate.pagination!, maxPages: 1 } };
  const service = new ScrapingService(async (url) => {
    const number = Number(new URL(url).searchParams.get("page"));
    return number <= 2
      ? Array.from({ length: 300 }, (_, index) => html(`${number}-${index}`)).join("")
      : "<main></main>";
  });
  const result = await service.collect("https://fixture.example/items", legacy);
  expect(result.articles).toHaveLength(600);
  expect(result.articles.at(-1)?.title).toBe("Article 2-299");
}, 15000);
test("detects repeated pages even if their article order changes and reports why pagination stopped", async () => {
  let calls = 0;
  const service = new ScrapingService(async () => {
    calls++;
    return calls === 1 ? html("one") + html("two") : html("two") + html("one");
  });
  const result = await service.collect("https://fixture.example/items", paginate);
  expect(calls).toBe(2);
  expect(result.articles).toHaveLength(2);
  expect(result.warnings?.[0]).toContain("page 2");
}, 15000);
test("continues across overlapping pages until empty and stops cycles of previously seen pages", async () => {
  const pages: number[] = [];
  const service = new ScrapingService(async (url) => {
    const number = Number(new URL(url).searchParams.get("page"));
    pages.push(number);
    return number === 1
      ? html("one") + html("two")
      : number === 2
        ? html("two")
        : number === 3
          ? html("three")
          : html("two") + html("one");
  });
  const result = await service.collect("https://fixture.example/items", paginate);
  expect(pages).toEqual([1, 2, 3, 4]);
  expect(result.articles.map((item) => item.title)).toEqual([
    "Article one",
    "Article two",
    "Article three",
  ]);
  expect(result.warnings).toHaveLength(1);
}, 15000);
test("a later page with invalid title selectors fails instead of presenting a partial collection as complete", async () => {
  const service = new ScrapingService(async (url) =>
    new URL(url).searchParams.get("page") === "1"
      ? html("one")
      : "<article><h3>Titre différent</h3><a href='/two'>Lire</a></article>",
  );
  await expect(service.collect("https://fixture.example/items", paginate)).rejects.toMatchObject({
    code: "INVALID_SCRAPING_EXTRACTION",
  });
}, 15000);
test("browser extracts and deduplicates relative links until an empty page", async () => {
  const requests: string[] = [];
  const service = new ScrapingService(async (url) => {
    requests.push(url);
    const number = Number(new URL(url).searchParams.get("page"));
    return number <= 2 ? html("common") + html(String(number)) : "<p>Fin</p>";
  });
  const result = await service.collect("https://fixture.example/items", paginate);
  expect(requests).toHaveLength(3);
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
  test("accepts and saves paginated sources without retaining a legacy page cap", async () => {
    const legacy = {
      ...paginate,
      pagination: { ...paginate.pagination!, startPage: 0, maxPages: 15 },
    };
    const url = "https://fixture.example/paginated";
    const preview = await agent.post("/sources/scraping/test").send({ url, config: legacy });
    expect(preview.status).toBe(200);
    expect(preview.body.warnings[0]).toContain("page 1");
    const saved = await agent
      .post("/sources")
      .send({ url, type: "SCRAPING", scrapingConfig: legacy });
    expect(saved.status).toBe(201);
    expect(saved.body.scrapingConfig.pagination).toEqual({
      strategy: "QUERY_PARAM",
      queryParam: "page",
      startPage: 0,
    });
    expect(
      (await db.source.findUniqueOrThrow({ where: { id: saved.body.id } })).scrapingConfig,
    ).toEqual(saved.body.scrapingConfig);
  }, 15000);
});
