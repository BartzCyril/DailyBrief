import { expect, test } from "bun:test";
import type { ArticlePreview, ScrapingConfig } from "@dailybrief/shared";
import {
  filterRecentArticles,
  parsePublicationDate,
  recentArticleWindow,
  type RecentArticleOptions,
} from "../src/recent-articles";
import { parseRss, RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { SourceCollector } from "../src/collection";
import type { Db } from "../src/db";

const window = recentArticleWindow("Europe/Paris", new Date("2026-10-11T10:00:00Z"));
const article = (publishedAt: string | null, id = publishedAt): ArticlePreview => ({
  title: `Article ${id}`,
  url: `https://fixture.example/${id}`,
  description: "Description",
  publishedAt,
});

test.each([
  [
    "observatoire",
    '<p class="date">24 Sept. 2026</p>',
    ".format-article .date",
    "2026-09-23T22:00:00.000Z",
    "2026-09-24T12:00:00Z",
  ],
  [
    "icom",
    '<p class="date">08.10.2026</p>',
    ".date",
    "2026-10-07T22:00:00.000Z",
    "2026-10-08T12:00:00Z",
  ],
  [
    "collectivites",
    '<p class="fr-card__detail">Culture</p><p class="fr-card__detail fr-icon-calendar-2-fill">Publié le 29 septembre 2026</p>',
    ".fr-card__detail",
    "2026-09-28T22:00:00.000Z",
    "2026-09-29T12:00:00Z",
  ],
])(
  "scraping reads the publication date in the %s example and keeps it in the local recent window",
  async (name, dateHtml, dateSelector, expected, now) => {
    const page = `<article class="entry format-article"><h2><a href="/${name}">Article ${name}</a></h2><p class="description">Description ${name}</p>${dateHtml}</article>`;
    const service = new ScrapingService(async () => page);
    const result = await service.collect(
      "https://fixture.example/news",
      {
        articleSelector: ".entry",
        titleSelector: "h2",
        linkSelector: "h2 a",
        descriptionSelector: ".description",
        dateSelector: dateSelector!,
        mode: "SCROLL",
        scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
      },
      { window: recentArticleWindow("Europe/Paris", new Date(now!)) },
    );
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.publishedAt).toBe(expected!);
  },
  15000,
);

test("scraping reads date metadata, nested time elements and visible fallbacks without returning raw date fields", async () => {
  const dates = [
    '<time class="date" datetime="">08.10.2026</time>',
    '<time class="date" datetime="invalid">08.10.2026</time>',
    '<meta class="date" itemprop="datePublished" content="2026-10-08T12:30:00Z">',
    '<p class="date">Publié le<time datetime="2026-10-08T12:30:00Z">8 octobre 2026</time></p>',
    '<p class="date" data-date="2026-10-08"></p>',
  ];
  const service = new ScrapingService(async () =>
    dates
      .map(
        (date, index) =>
          `<article><h2><a href="/${index}">Article ${index}</a></h2><p class="description">Description ${index}</p>${date}</article>`,
      )
      .join(""),
  );
  const result = await service.collect("https://fixture.example/news", {
    articleSelector: "article",
    titleSelector: "h2",
    linkSelector: "h2 a",
    descriptionSelector: ".description",
    dateSelector: ".date",
    mode: "SCROLL",
    scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
  });
  expect(result.articles.map((article) => article.publishedAt)).toEqual([
    "2026-10-08T00:00:00.000Z",
    "2026-10-08T00:00:00.000Z",
    "2026-10-08T12:30:00.000Z",
    "2026-10-08T12:30:00.000Z",
    "2026-10-08T00:00:00.000Z",
  ]);
  expect(JSON.stringify(result)).not.toContain("dateGroups");
}, 15000);

test("a date selector matching conflicting dates cannot silently choose the wrong publication day", async () => {
  const service = new ScrapingService(
    async () =>
      '<article><h2><a href="/one">Article</a></h2><p class="date">08.10.2026</p><p class="date">09.10.2026</p></article>',
  );
  const result = await service.collect(
    "https://fixture.example/news",
    {
      articleSelector: "article",
      titleSelector: "h2",
      linkSelector: "h2 a",
      dateSelector: ".date",
      mode: "SCROLL",
      scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
    },
    { window: recentArticleWindow("Europe/Paris", new Date("2026-10-09T12:00:00Z")) },
  );
  expect(result.articles).toEqual([]);
  expect(result.warnings?.join(" ")).toContain("date de publication inexploitable");
}, 15000);

test("a matching article wrapper does not hide its actual child publication date", async () => {
  const service = new ScrapingService(
    async () =>
      '<article class="date"><h2><a href="/one">Un article daté</a></h2><p class="date">2026-10-08</p></article>',
  );
  const result = await service.collect("https://fixture.example/news", {
    articleSelector: "article",
    titleSelector: "h2",
    linkSelector: "h2 a",
    dateSelector: ".date",
    mode: "SCROLL",
    scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
  });
  expect(result.articles[0]?.publishedAt).toBe("2026-10-08T00:00:00.000Z");
}, 15000);

test("publication windows use local calendar days, including DST transitions and UTC boundaries", () => {
  expect(window).toEqual({
    start: new Date("2026-10-09T22:00:00Z"),
    end: new Date("2026-10-11T22:00:00Z"),
    timezone: "Europe/Paris",
    date: "2026-10-11",
  });
  const spring = recentArticleWindow("Europe/Paris", new Date("2026-03-29T12:00:00Z"));
  expect((spring.end.getTime() - spring.start.getTime()) / 3600000).toBe(47);
  const autumn = recentArticleWindow("Europe/Paris", new Date("2026-10-25T12:00:00Z"));
  expect((autumn.end.getTime() - autumn.start.getTime()) / 3600000).toBe(49);
  expect(recentArticleWindow("America/New_York", new Date("2026-10-11T01:00:00Z")).date).toBe(
    "2026-10-10",
  );
});

test("publication parsing respects explicit offsets and interprets French or offset-free dates locally", () => {
  expect(parsePublicationDate("2026-10-10", "Europe/Paris")).toBe("2026-10-09T22:00:00.000Z");
  expect(parsePublicationDate("2026-10-10T00:30:00", "Europe/Paris")).toBe(
    "2026-10-09T22:30:00.000Z",
  );
  expect(parsePublicationDate("2026-10-10T00:30:00-04:00", "Europe/Paris")).toBe(
    "2026-10-10T04:30:00.000Z",
  );
  expect(parsePublicationDate("le 10 Octobre 2026", "Europe/Paris")).toBe(
    "2026-10-09T22:00:00.000Z",
  );
  expect(parsePublicationDate("Publié le 11/10/2026 à 15h30", "Europe/Paris")).toBe(
    "2026-10-11T13:30:00.000Z",
  );
  expect(parsePublicationDate("Tue, 06 Oct 2026 10:00:00 GMT", "Europe/Paris")).toBe(
    "2026-10-06T10:00:00.000Z",
  );
  for (const value of ["", "date inconnue", "31 février 2026", "2026-02-31"])
    expect(parsePublicationDate(value, "Europe/Paris")).toBeNull();
});

test("recent filtering excludes undated, old and future articles and preserves J-1's exact boundary", () => {
  const result = filterRecentArticles(
    [
      article("2026-10-09T21:59:59.999Z"),
      article("2026-10-09T22:00:00.000Z"),
      article("2026-10-11T21:59:59.999Z"),
      article("2026-10-11T22:00:00.000Z"),
      article(null),
      article("malformed"),
    ],
    window,
  );
  expect(result.articles).toHaveLength(2);
  expect(result.ignored).toEqual({ old: 1, future: 1, undated: 2 });
  expect(result.warnings).toHaveLength(3);
});

const rss = (dates: Array<string | null>) =>
  `<rss><channel>${dates.map((date, index) => `<item><title>Article ${index}</title><link>https://fixture.example/${index}</link>${date ? `<pubDate>${date}</pubDate>` : ""}</item>`).join("")}</channel></rss>`;

test("RSS cutoff validates the complete order and never loses a recent item after an older entry", () => {
  const sorted = parseRss(
    rss(["2026-10-11", "2026-10-10", "2026-10-09", "2026-10-08"]),
    "https://fixture.example/feed",
    false,
    { window },
  );
  expect(sorted.articles).toHaveLength(2);
  expect(sorted.warnings?.join(" ")).toContain("ordre chronologique vérifié");
  const unordered = parseRss(
    rss(["2026-10-09", "2026-10-11", null, "2026-10-10"]),
    "https://fixture.example/feed",
    false,
    { window, newestFirst: true },
  );
  expect(unordered.articles.map((item) => item.title)).toEqual(["Article 1", "Article 3"]);
  expect(unordered.warnings?.join(" ")).toContain("date de publication inexploitable");
  expect(unordered.warnings?.join(" ")).toContain("n'est pas respecté");
  expect(parseRss(rss(["2026-10-09"]), "https://fixture.example/feed").articles).toHaveLength(1);
  expect(
    parseRss(rss(["2026-10-09"]), "https://fixture.example/feed", false, { window }).articles,
  ).toEqual([]);
});

const config: ScrapingConfig = {
  articleSelector: "article",
  titleSelector: "h2",
  linkSelector: "a",
  dateSelector: "time",
  descriptionSelector: "p",
  mode: "PAGINATE",
  pagination: { strategy: "QUERY_PARAM", queryParam: "page", startPage: 1 },
};
const html = (date: string | null, id: string) =>
  `<article><h2>Article ${id}</h2><a href="/${id}">Lire</a><p>Description</p>${date ? `<time>${date}</time>` : ""}</article>`;

test("declared chronological scraping stops pagination as soon as archives are reached", async () => {
  const visited: number[] = [];
  const service = new ScrapingService(async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    visited.push(page);
    if (page === 1) return html("le 11 Octobre 2026", "today");
    if (page === 2)
      return html("le 10 Octobre 2026", "yesterday") + html("le 09 Octobre 2026", "old");
    throw new Error("Archives must not be opened");
  });
  const result = await service.collect("https://fixture.example/news", config, {
    window,
    newestFirst: true,
  });
  expect(visited).toEqual([1, 2]);
  expect(result.articles.map((item) => item.title)).toEqual(["Article today", "Article yesterday"]);
}, 15000);

test("scraping without an order guarantee keeps looking after old articles", async () => {
  const visited: number[] = [];
  const service = new ScrapingService(async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    visited.push(page);
    return page === 1
      ? html("2026-10-08", "old")
      : page === 2
        ? html("2026-10-11", "recent")
        : "<main></main>";
  });
  const result = await service.collect("https://fixture.example/news", config, { window });
  expect(visited).toEqual([1, 2, 3]);
  expect(result.articles.map((item) => item.title)).toEqual(["Article recent"]);
}, 15000);

test("an observed date inversion or missing date disables chronological early stopping", async () => {
  for (const first of [
    html("2026-10-08", "old") + html("2026-10-11", "recent"),
    html(null, "undated") + html("2026-10-08", "old"),
  ]) {
    const visited: number[] = [];
    const service = new ScrapingService(async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      visited.push(page);
      return page === 1 ? first : page === 2 ? html("2026-10-10", "later") : "<main></main>";
    });
    const result = await service.collect("https://fixture.example/news", config, {
      window,
      newestFirst: true,
    });
    expect(visited).toEqual([1, 2, 3]);
    expect(result.articles.at(-1)?.title).toBe("Article later");
    expect(result.warnings?.join(" ")).toContain("sans arrêt anticipé");
  }
}, 20000);

test("chronological button loading stops after an old batch and ignores repeated DOM entries", async () => {
  const loads: string[] = [];
  const service = new ScrapingService(async (url) => {
    if (url.includes("/batch/")) {
      loads.push(url);
      if (loads.length > 1) throw new Error("Do not load another archive batch");
      return JSON.stringify({
        html: html("2026-10-10", "yesterday") + html("2026-10-09", "old"),
      });
    }
    return `${html("2026-10-11", "today")}<button id="more">Plus</button><script>
      let n=0; document.querySelector('#more').onclick=async()=>{
        const response=await fetch('/batch/'+(++n)); const data=await response.json();
        document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      };
    </script>`;
  });
  const result = await service.collect(
    "https://fixture.example/news",
    { ...config, mode: "LOAD_MORE", loadMore: { buttonSelector: "#more", waitTimeoutMs: 2000 } },
    { window, newestFirst: true },
  );
  expect(loads).toEqual(["https://fixture.example/batch/1"]);
  expect(result.articles.map((item) => item.title)).toEqual(["Article today", "Article yesterday"]);
  expect(result.warnings?.join(" ")).not.toContain("sans arrêt anticipé");
}, 15000);

test("chronological scrolling does not trigger another request once the initial page reaches archives", async () => {
  const visited: string[] = [];
  const service = new ScrapingService(async (url) => {
    visited.push(url);
    if (visited.length > 1) throw new Error("Do not scroll further into archives");
    return `${html("2026-10-11", "today")}${html("2026-10-09", "old")}<script>
      window.scrollTo=()=>fetch('/archive');
    </script>`;
  });
  const result = await service.collect(
    "https://fixture.example/news",
    { ...config, mode: "SCROLL", scroll: { maxScrolls: 8, waitAfterScrollMs: 100 } },
    { window, newestFirst: true },
  );
  expect(visited).toEqual(["https://fixture.example/news"]);
  expect(result.articles.map((item) => item.title)).toEqual(["Article today"]);
}, 15000);

test("a source containing only invalid or old publication dates completes with an empty result and warnings", async () => {
  const service = new ScrapingService(
    async () => html("date inconnue", "unknown") + html("2026-10-01", "old"),
  );
  const result = await service.collect(
    "https://fixture.example/news",
    { ...config, mode: "SCROLL", scroll: { maxScrolls: 0, waitAfterScrollMs: 100 } },
    { window },
  );
  expect(result.articles).toEqual([]);
  expect(result.warnings?.join(" ")).toContain("date de publication inexploitable");
  expect(result.warnings?.join(" ")).toContain("antérieur(s)");
}, 15000);

test("collection boundaries apply to custom services and a failed source does not remove successful results", async () => {
  const db = {
    source: {
      findMany: async () => [
        {
          id: "rss",
          type: "RSS",
          url: "https://fixture.example/feed",
          articleLinkSelector: null,
          newestFirst: false,
        },
        {
          id: "scrape",
          type: "SCRAPING",
          url: "https://fixture.example/news",
          scrapingConfig: config,
          newestFirst: false,
        },
      ],
    },
  } as unknown as Db;
  class FixtureRss extends RssService {
    override async collect(_url: string, _preserveUndated = false, options?: RecentArticleOptions) {
      expect(options?.newestFirst).toBe(true);
      return { articles: [article("2026-10-10"), article("2026-10-08"), article(null)] };
    }
  }
  class FailedScraping extends ScrapingService {
    override async collect(): Promise<never> {
      throw new Error("Unavailable source");
    }
  }
  const results = await new SourceCollector(db, new FixtureRss(), new FailedScraping()).collect(
    "user",
    undefined,
    window,
  );
  expect(results[0]?.articles).toHaveLength(1);
  expect(results[0]?.articles[0]?.publishedAt).toBe("2026-10-09T22:00:00.000Z");
  expect(results[0]?.warnings?.join(" ")).toContain("date de publication inexploitable");
  expect(results[1]?.success).toBe(false);
});
