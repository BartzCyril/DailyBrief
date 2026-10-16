import { expect, test } from "bun:test";
import type { ScrapingConfig } from "@dailybrief/shared";
import { ScrapingService } from "../src/scraping";

const selectors = { articleSelector: "article", titleSelector: "h2", linkSelector: "a" };
const card = (id: string) =>
  `<article><h2>Article ${id}</h2><a href="/articles/${id}">Lire</a></article>`;
const paginate: ScrapingConfig = {
  ...selectors,
  mode: "PAGINATE",
  pagination: { strategy: "QUERY_PARAM", queryParam: "page", startPage: 1 },
};

test("ends pagination on empty matching list blocks and retains previous articles", async () => {
  const pages: number[] = [];
  const service = new ScrapingService(async (url) => {
    const number = Number(new URL(url).searchParams.get("page"));
    pages.push(number);
    return number < 33 ? card(String(number)) : "<article><p>Aucun résultat.</p></article>";
  });
  const result = await service.collect("https://fixture.example/news", {
    ...paginate,
    pagination: { ...paginate.pagination!, startPage: 31 },
  });
  expect(pages).toEqual([31, 32, 33]);
  expect(result.articles.map((article) => article.title)).toEqual(["Article 31", "Article 32"]);
  expect(result.warnings?.join(" ")).toContain("Fin de pagination à la page 33");
}, 15000);

test("still rejects untitled matching blocks on the initial page", async () => {
  const service = new ScrapingService(async () => "<article><p>Aucun résultat.</p></article>");
  await expect(service.collect("https://fixture.example/news", paginate)).rejects.toMatchObject({
    code: "INVALID_SCRAPING_EXTRACTION",
  });
}, 10000);

for (const startPage of [0, 12]) {
  test(`previews at most five pagination pages from page ${startPage}`, async () => {
    const pages: number[] = [];
    const service = new ScrapingService(async (url) => {
      const number = Number(new URL(url).searchParams.get("page"));
      pages.push(number);
      if (number >= startPage + 5) throw new Error("Preview fetched a sixth page");
      return card(String(number));
    });
    const result = await service.preview("https://fixture.example/news", {
      ...paginate,
      pagination: { ...paginate.pagination!, startPage },
    });
    expect(pages).toEqual(Array.from({ length: 5 }, (_, index) => startPage + index));
    expect(result.articles).toHaveLength(5);
    expect(result.warnings?.join(" ")).toContain("Test limité à 5 pages");
  }, 10000);
}

test("preview stops earlier at the end of the list", async () => {
  const pages: number[] = [];
  const service = new ScrapingService(async (url) => {
    const number = Number(new URL(url).searchParams.get("page"));
    pages.push(number);
    return number <= 2 ? card(String(number)) : "<article></article>";
  });
  const result = await service.preview("https://fixture.example/news", paginate);
  expect(pages).toEqual([1, 2, 3]);
  expect(result.articles).toHaveLength(2);
  expect(result.warnings?.join(" ")).not.toContain("Test limité");
}, 10000);

test("previews five scrolls while collection keeps the configured eight", async () => {
  const service = new ScrapingService(
    async () => `${card("initial")}<script>
    let n=0; window.scrollTo=()=>document.body.insertAdjacentHTML('beforeend',
      '<article><h2>Scroll '+(++n)+'</h2><a href="/scroll/'+n+'">Lire</a></article>');
  </script>`,
  );
  const config: ScrapingConfig = {
    ...selectors,
    mode: "SCROLL",
    scroll: { maxScrolls: 8, waitAfterScrollMs: 100 },
  };
  const preview = await service.preview("https://fixture.example/news", config);
  expect(preview.articles).toHaveLength(6);
  expect(preview.articles.at(-1)?.title).toBe("Scroll 5");
  expect(preview.warnings?.join(" ")).toContain("Test limité à 5 scrolls");
  const complete = await service.collect("https://fixture.example/news", config);
  expect(complete.articles).toHaveLength(9);
  expect(complete.articles.at(-1)?.title).toBe("Scroll 8");
  const shorter = await service.preview("https://fixture.example/news", {
    ...config,
    scroll: { ...config.scroll!, maxScrolls: 2 },
  });
  expect(shorter.articles).toHaveLength(3);
  expect(shorter.warnings).toBeUndefined();
}, 15000);

test("previews five load-more clicks and retains initial and dynamically loaded articles", async () => {
  const batches: number[] = [];
  const service = new ScrapingService(async (url) => {
    if (url.includes("/batch/")) {
      const number = Number(url.split("/").at(-1));
      batches.push(number);
      if (number > 5) throw new Error("Preview clicked a sixth time");
      return JSON.stringify({ html: card(String(number)) });
    }
    return `${card("initial")}<button id="more">Plus</button><script>
      let n=0; document.querySelector('#more').onclick=async()=>{
        const data=await(await fetch('/batch/'+(++n))).json();
        document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      };
    </script>`;
  });
  const result = await service.preview("https://fixture.example/news", {
    ...selectors,
    mode: "LOAD_MORE",
    loadMore: { buttonSelector: "#more", waitTimeoutMs: 2000 },
  });
  expect(batches).toEqual([1, 2, 3, 4, 5]);
  expect(result.articles).toHaveLength(6);
  expect(result.articles.at(-1)?.title).toBe("Article 5");
  expect(result.warnings?.join(" ")).toContain("Test limité à 5 clics");
}, 15000);
