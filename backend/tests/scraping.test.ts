import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { ScrapingConfig } from "@dailybrief/shared";
import { scrapingInputSchema, scrapingSchema } from "../../shared/src/scraping";
import { ScrapingService, paginationUrl } from "../src/scraping";
import { createApp } from "../src/app";
import { AppError, UpstreamHttpError } from "../src/errors";
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
test("requires description and date for source input while retaining saved legacy configurations", () => {
  expect(scrapingInputSchema.safeParse(scroll).success).toBe(true);
  for (const field of ["descriptionSelector", "dateSelector"] as const) {
    for (const value of [undefined, null, "", "   "]) {
      expect(scrapingInputSchema.safeParse({ ...scroll, [field]: value }).success).toBe(false);
    }
  }
  const legacy = { ...scroll, descriptionSelector: null, dateSelector: undefined };
  expect(scrapingSchema.safeParse(legacy).success).toBe(true);
});
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
test("keeps all 37 pages when page 38 returns HTTP 404 with a path-based template", async () => {
  const pages: number[] = [];
  const service = new ScrapingService(async (url) => {
    const number = Number(new URL(url).pathname.split("/").filter(Boolean).at(-1));
    pages.push(number);
    if (number === 38) throw new UpstreamHttpError(404, url);
    return (
      '<meta charset="utf-8">' +
      Array.from(
        { length: 20 },
        (_, index) =>
          `<article class="post"><h2 class="fl-post-title"><a href="/member/${number}-${index}">Adhérent ${number}-${index}</a></h2><a class="fl-post-more-link" href="/member/${number}-${index}">Lire</a></article>`,
      ).join("")
    );
  });
  const result = await service.collect("https://fixture.example/adherents/", {
    articleSelector: ".post",
    titleSelector: ".fl-post-title a",
    linkSelector: ".fl-post-more-link",
    mode: "PAGINATE",
    pagination: {
      strategy: "URL_TEMPLATE",
      startPage: 1,
      urlTemplate: "https://fixture.example/adherents/page/{page}/",
    },
  });
  expect(pages).toEqual(Array.from({ length: 38 }, (_, index) => index + 1));
  expect(result.articles).toHaveLength(740);
  expect(result.articles.at(-1)?.title).toBe("Adhérent 37-19");
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings?.[0]).toContain("page 38");
  expect(result.warnings?.[0]).toContain("HTTP 404");
}, 45000);
test("recognizes HTTP 410 as an end after valid pages with query pagination", async () => {
  const service = new ScrapingService(async (url) => {
    if (new URL(url).searchParams.get("page") === "2") throw new UpstreamHttpError(410, url);
    return html("one");
  });
  const result = await service.collect("https://fixture.example/items", paginate);
  expect(result.articles).toHaveLength(1);
  expect(result.warnings?.[0]).toContain("HTTP 410");
}, 15000);
test("rejects missing first pages for validation, pagination and scrolling", async () => {
  for (const status of [404, 410]) {
    const service = new ScrapingService(async (url) => {
      throw new UpstreamHttpError(status, url);
    });
    const error = { code: "UPSTREAM_ERROR", upstreamStatus: status };
    expect(
      await service.collect("https://fixture.example/items", paginate).catch((error) => error),
    ).toMatchObject(error);
    expect(
      await service
        .validateFirstPage("https://fixture.example/items", paginate)
        .catch((error) => error),
    ).toMatchObject(error);
    expect(
      await service.collect("https://fixture.example/items", scroll).catch((error) => error),
    ).toMatchObject(error);
  }
}, 15000);
test("later blocking, rate limits, server and network failures never become a successful partial collection", async () => {
  for (const status of [403, 429, 500, 503]) {
    const service = new ScrapingService(async (url) => {
      if (new URL(url).searchParams.get("page") === "2") throw new UpstreamHttpError(status, url);
      return html("one");
    });
    expect(
      await service.collect("https://fixture.example/items", paginate).catch((error) => error),
    ).toMatchObject({
      code: "UPSTREAM_ERROR",
      upstreamStatus: status,
      url: "https://fixture.example/items?page=2",
    });
  }
  const service = new ScrapingService(async (url) => {
    if (new URL(url).searchParams.get("page") === "2")
      throw new AppError(504, "Délai dépassé.", "TIMEOUT");
    return html("one");
  });
  expect(
    await service.collect("https://fixture.example/items", paginate).catch((error) => error),
  ).toMatchObject({
    code: "TIMEOUT",
  });
}, 30000);
test("does not confuse missing embedded frames or redirected pages with the end of pagination", async () => {
  const frames = new ScrapingService(async (url) => {
    if (url.endsWith("/missing-frame")) throw new UpstreamHttpError(404, url);
    if (new URL(url).searchParams.get("page") === "2") throw new UpstreamHttpError(503, url);
    return html("one") + '<iframe src="/missing-frame"></iframe>';
  });
  expect(
    await frames.collect("https://fixture.example/items", paginate).catch((error) => error),
  ).toMatchObject({
    upstreamStatus: 503,
  });
  const redirected = new ScrapingService(async (url) => {
    if (new URL(url).searchParams.get("page") === "2")
      throw new UpstreamHttpError(404, "https://fixture.example/login");
    return html("one");
  });
  expect(
    await redirected.collect("https://fixture.example/items", paginate).catch((error) => error),
  ).toMatchObject({ upstreamStatus: 404, url: "https://fixture.example/login" });
}, 15000);
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
test("first-page validation does not scroll but keeps executing page JavaScript", async () => {
  const requests: string[] = [];
  const service = new ScrapingService(async (url) => {
    requests.push(url);
    return `<body style="min-height:5000px"><article></article><script>
      document.querySelector('article').innerHTML='<h2>Article JS</h2><a href="/js">Lire</a>';
      window.addEventListener('scroll',()=>fetch('/scrolled'));
    </script></body>`;
  });
  await service.validateFirstPage("https://fixture.example/scroll-validation", scroll);
  expect(requests).toEqual(["https://fixture.example/scroll-validation"]);
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
  const requests: string[] = [];
  const app = createApp(db, redis, config, {
    scraping: new ScrapingService(async (url) => {
      requests.push(url);
      if (url.endsWith("/button-batch")) return JSON.stringify({ html: html("button-next") });
      if (url.endsWith("/button-source"))
        return `${html("button-first")}<button id="more">Plus</button><script>document.querySelector('#more').onclick=async()=>{const data=await (await fetch('/button-batch')).json();document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);document.querySelector('#more').remove();};</script>`;
      if (url.includes("http-end") && new URL(url).searchParams.get("page") === "2")
        throw new UpstreamHttpError(404, url);
      if (url.includes("http-blocked")) throw new UpstreamHttpError(403, url);
      if (
        url.includes("first-page-only") &&
        new URL(url).searchParams.get("page") !== "5" &&
        !url.endsWith("/5/")
      )
        throw new AppError(502, "Page suivante inaccessible.", "NETWORK_ERROR");
      return html("1");
    }),
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
  test("returns a preview and end warning for a later 404, but precise HTTP diagnostics for a missing first page or blocking", async () => {
    const url = "https://fixture.example/http-end";
    const preview = await agent.post("/sources/scraping/test").send({ url, config: paginate });
    expect(preview.status).toBe(200);
    expect(preview.body.articles).toHaveLength(1);
    expect(preview.body.warnings[0]).toContain("HTTP 404");
    const first = await agent
      .post("/sources/scraping/test")
      .send({ url, config: { ...paginate, pagination: { ...paginate.pagination, startPage: 2 } } });
    expect(first.status).toBe(502);
    expect(first.body).toMatchObject({
      code: "UPSTREAM_ERROR",
      upstreamStatus: 404,
      url: `${url}?page=2`,
    });
    expect(first.body.message).toContain("HTTP 404");
    const blocked = await agent
      .post("/sources/scraping/test")
      .send({ url: "https://fixture.example/http-blocked", config: paginate });
    expect(blocked.status).toBe(502);
    expect(blocked.body).toMatchObject({ code: "UPSTREAM_ERROR", upstreamStatus: 403 });
    expect(blocked.body.message).toContain("HTTP 403");
  }, 15000);
  test("creation and editing validate only the configured starting page while explicit tests still visit later pages", async () => {
    for (const pagination of [
      { strategy: "QUERY_PARAM" as const, queryParam: "page", startPage: 5 },
      {
        strategy: "URL_TEMPLATE" as const,
        urlTemplate: "https://fixture.example/first-page-only-template/page/{page}/",
        startPage: 5,
      },
    ]) {
      const sourceUrl = `https://fixture.example/first-page-only-${pagination.strategy}`;
      const scrapingConfig = { ...paginate, pagination };
      const firstUrl = paginationUrl(sourceUrl, scrapingConfig, 5);
      requests.length = 0;
      const saved = await agent
        .post("/sources")
        .send({ url: sourceUrl, type: "SCRAPING", scrapingConfig });
      expect(saved.status).toBe(201);
      expect(requests).toEqual([firstUrl]);
      expect(saved.body.scrapingConfig).toEqual(scrapingConfig);
      requests.length = 0;
      const editedConfig = { ...scrapingConfig, descriptionSelector: "p:first-of-type" };
      expect(
        (await agent.patch(`/sources/${saved.body.id}`).send({ scrapingConfig: editedConfig }))
          .status,
      ).toBe(204);
      expect(requests).toEqual([firstUrl]);
      expect(
        (await db.source.findUniqueOrThrow({ where: { id: saved.body.id } })).scrapingConfig,
      ).toEqual(editedConfig);
      requests.length = 0;
      const preview = await agent
        .post("/sources/scraping/test")
        .send({ url: sourceUrl, config: editedConfig });
      expect(preview.status).toBe(502);
      expect(requests).toEqual([firstUrl, paginationUrl(sourceUrl, scrapingConfig, 6)]);
      requests.length = 0;
      const before = await db.source.findUniqueOrThrow({ where: { id: saved.body.id } });
      const failed = await agent
        .patch(`/sources/${saved.body.id}`)
        .send({ scrapingConfig: { ...editedConfig, pagination: { ...pagination, startPage: 6 } } });
      expect(failed.status).toBe(502);
      expect(requests).toEqual([paginationUrl(sourceUrl, scrapingConfig, 6)]);
      expect(await db.source.findUniqueOrThrow({ where: { id: saved.body.id } })).toEqual(before);
    }
  }, 30000);
  test("creates and edits a button source without clicking while previews load all batches without saving articles", async () => {
    const url = "https://fixture.example/button-source";
    const config: ScrapingConfig = {
      ...base,
      mode: "LOAD_MORE",
      loadMore: { buttonSelector: "#more", waitTimeoutMs: 1000 },
    };
    const articleCount = await db.article.count({ where: { userId } });
    requests.length = 0;
    const saved = await agent
      .post("/sources")
      .send({ url, type: "SCRAPING", scrapingConfig: config });
    expect(saved.status).toBe(201);
    expect(requests).toEqual([url]);
    expect(saved.body.scrapingConfig).toEqual(config);
    const edited = { ...config, loadMore: { buttonSelector: "button#more", waitTimeoutMs: 2000 } };
    requests.length = 0;
    expect(
      (await agent.patch(`/sources/${saved.body.id}`).send({ scrapingConfig: edited })).status,
    ).toBe(204);
    expect(requests).toEqual([url]);
    requests.length = 0;
    const preview = await agent.post("/sources/scraping/test").send({ url, config: edited });
    expect(preview.status).toBe(200);
    expect(preview.body.articles).toHaveLength(2);
    expect(requests).toEqual([url, "https://fixture.example/button-batch"]);
    expect(await db.article.count({ where: { userId } })).toBe(articleCount);
    const before = await db.source.findUniqueOrThrow({ where: { id: saved.body.id } });
    expect(
      (
        await agent.patch(`/sources/${saved.body.id}`).send({
          scrapingConfig: { ...edited, loadMore: { ...edited.loadMore, buttonSelector: "??" } },
        })
      ).status,
    ).toBe(422);
    expect(await db.source.findUniqueOrThrow({ where: { id: saved.body.id } })).toEqual(before);
  }, 15000);
});
