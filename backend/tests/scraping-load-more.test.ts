import { test, expect } from "bun:test";
import type { ScrapingConfig } from "@dailybrief/shared";
import { scrapingSchema } from "../../shared/src/scraping";
import { ScrapingService } from "../src/scraping";
import { AppError } from "../src/errors";
import { fetchRemoteText, type RemotePageOptions } from "../src/network";

const config: ScrapingConfig = {
  articleSelector: "article",
  titleSelector: "h2",
  linkSelector: "a",
  mode: "LOAD_MORE",
  loadMore: { buttonSelector: "#more", waitTimeoutMs: 1000 },
};
const card = (id: string) =>
  `<article><h2>Article ${id}</h2><a href="/articles/${id}">Lire</a></article>`;
const page = (script: string, button = '<button id="more">Plus</button>') =>
  `${card("first")}${button}<script>${script}</script>`;

test("requires button settings and a valid waiting delay", () => {
  expect(scrapingSchema.safeParse(config).success).toBe(true);
  for (const loadMore of [
    undefined,
    { buttonSelector: "", waitTimeoutMs: 1000 },
    { buttonSelector: "#more", waitTimeoutMs: 0 },
    { buttonSelector: "#more", waitTimeoutMs: 60001 },
  ])
    expect(scrapingSchema.safeParse({ ...config, loadMore }).success).toBe(false);
});

test("clicks beyond fifteen batches, deduplicates overlaps and stops when the button disappears", async () => {
  const loads: string[] = [];
  const service = new ScrapingService(async (url) => {
    if (url.includes("/batch/")) {
      loads.push(url);
      return JSON.stringify({ html: card("first") + card(url.split("/").at(-1)!) });
    }
    return page(`let n=0; document.querySelector('#more').onclick=async()=>{
      const response=await fetch('/batch/'+(++n)); const data=await response.json();
      document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      if(n===17) document.querySelector('#more').remove();
    };`);
  });
  const result = await service.collect("https://fixture.example/news", config);
  expect(loads).toHaveLength(17);
  expect(result.articles).toHaveLength(18);
  expect(result.articles.at(-1)?.title).toBe("Article 17");
  expect(result.warnings).toBeUndefined();
}, 20000);

test("waits for delayed DOM articles and stops on a disabled button", async () => {
  const service = new ScrapingService(async () =>
    page(`document.querySelector('#more').onclick=()=>setTimeout(()=>{
    document.querySelector('#more').insertAdjacentHTML('beforebegin',${JSON.stringify(card("delayed"))});
    document.querySelector('#more').disabled=true;
  },500);`),
  );
  const result = await service.collect("https://fixture.example/news", config);
  expect(result.articles.map((a) => a.title)).toEqual(["Article first", "Article delayed"]);
  expect(result.warnings).toBeUndefined();
}, 10000);
test("waits for every pending AJAX request before accepting a staged article batch", async () => {
  const service = new ScrapingService(async (url) => {
    if (url.endsWith("/slow")) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return JSON.stringify({ html: card("slow") });
    }
    if (url.endsWith("/fast")) return JSON.stringify({ html: card("fast") });
    return page(`document.querySelector('#more').onclick=()=>{
      document.querySelector('#more').disabled=true;
      for(const part of ['fast','slow']) fetch('/'+part).then(r=>r.json()).then(data=>{
        document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      });
    };`);
  });
  const result = await service.collect("https://fixture.example/news", {
    ...config,
    loadMore: { ...config.loadMore!, waitTimeoutMs: 2000 },
  });
  expect(result.articles.map((a) => a.title)).toEqual([
    "Article first",
    "Article fast",
    "Article slow",
  ]);
}, 10000);

test("preserves replaced article lists and reports repeated or ineffective clicks", async () => {
  const service = new ScrapingService(async () =>
    page(`let n=0; document.querySelector('#more').onclick=()=>{
    document.querySelector('article').outerHTML = n++ === 0 ? ${JSON.stringify(card("second"))} : ${JSON.stringify(card("first"))};
  };`),
  );
  const result = await service.collect("https://fixture.example/news", config);
  expect(result.articles.map((a) => a.title)).toEqual(["Article first", "Article second"]);
  expect(result.warnings?.[0]).toContain("aucun nouvel article");
  expect(result.warnings?.[0]).toContain("2 clic(s)");
}, 10000);

test("keeps first-page validation free of clicks and detects invalid button CSS", async () => {
  const requests: string[] = [];
  const service = new ScrapingService(async (url) => {
    requests.push(url);
    return page("document.querySelector('#more').onclick=()=>fetch('/must-not-click');");
  });
  await service.validateFirstPage("https://fixture.example/news", config);
  expect(requests).toEqual(["https://fixture.example/news"]);
  const invalid = { ...config, loadMore: { ...config.loadMore!, buttonSelector: "??" } };
  expect(
    await service.validateFirstPage("https://fixture.example/news", invalid).catch((e) => e),
  ).toMatchObject({ code: "INVALID_LOAD_MORE_BUTTON" });
}, 10000);

test("reports a missing button and rejects ambiguous visible buttons", async () => {
  const absent = new ScrapingService(async () => card("first"));
  const result = await absent.collect("https://fixture.example/news", config);
  expect(result.articles).toHaveLength(1);
  expect(result.warnings?.[0]).toContain("Aucun bouton visible");
  const ambiguous = new ScrapingService(async () =>
    page("", '<button class="more">Plus</button><button class="more">Autre</button>'),
  );
  expect(
    await ambiguous
      .collect("https://fixture.example/news", {
        ...config,
        loadMore: { ...config.loadMore!, buttonSelector: ".more" },
      })
      .catch((e) => e),
  ).toMatchObject({ code: "INVALID_LOAD_MORE_BUTTON" });
}, 10000);

test("forwards same-origin AJAX POST bodies and headers through the guarded transport", async () => {
  const calls: Array<{ url: string; options?: RemotePageOptions }> = [];
  const service = new ScrapingService(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/ajax")) return JSON.stringify({ html: card("post") });
    return page(`document.querySelector('#more').onclick=async()=>{
      const response=await fetch('/ajax',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:'page=2&nonce=test'});
      const data=await response.json(); document.querySelector('#more').insertAdjacentHTML('beforebegin',data.html);
      document.querySelector('#more').remove();
    };`);
  });
  const result = await service.collect("https://fixture.example/news", config);
  expect(result.articles).toHaveLength(2);
  expect(calls[1]).toMatchObject({
    url: "https://fixture.example/ajax",
    options: {
      method: "POST",
      body: "page=2&nonce=test",
      contentType: "application/x-www-form-urlencoded",
      requestedWith: "XMLHttpRequest",
    },
  });
}, 10000);

test("does not treat AJAX failures or private and cross-origin POST targets as exhaustion", async () => {
  for (const target of [
    "https://fixture.example/failure",
    "http://127.0.0.1/private",
    "https://other.example/post",
  ]) {
    const calls: string[] = [];
    const service = new ScrapingService(async (url, options) => {
      calls.push(url);
      if (url.endsWith("/private")) return fetchRemoteText(url, options);
      if (url.endsWith("/failure"))
        throw new AppError(502, "Chargement inaccessible.", "UPSTREAM_ERROR");
      const init = target.includes("127.0.0.1") ? {} : { method: "POST", body: "page=2" };
      return page(
        `document.querySelector('#more').onclick=()=>fetch(${JSON.stringify(target)},${JSON.stringify(init)}).catch(()=>{});`,
      );
    });
    expect(
      await service.collect("https://fixture.example/news", config).catch((e) => e),
    ).toMatchObject({ code: target.endsWith("/failure") ? "UPSTREAM_ERROR" : "UNSAFE_URL" });
    if (target.includes("other.example")) expect(calls).toEqual(["https://fixture.example/news"]);
  }
}, 10000);
