import { beforeAll, afterAll, expect, test } from "bun:test";
import type { Browser } from "puppeteer";
import {
  launchScrapingBrowser,
  createScrapingPage,
  interceptRequests,
  navigateScrapingPage,
} from "../src/browser";
import type { ScrapingConfig } from "@dailybrief/shared";
import { consentPostAllowed, dismissCookieConsent } from "../src/cookie-consent";
import { ScrapingService } from "../src/scraping";
import { renderPublicSelectorPage } from "../src/selector-analysis";
import { selectorAnalysisInputSchema } from "../src/selector-assistance";

let browser: Browser;
beforeAll(async () => {
  browser = await launchScrapingBrowser();
}, 30000);
afterAll(async () => browser?.close());

const base = {
  articleSelector: "article",
  titleSelector: "h2",
  linkSelector: "a",
  dateSelector: "time",
  cookieConsentSelector: "#accept-cookies",
};
const article = (id: string) =>
  `<article><h2>Article ${id}</h2><a href="/articles/${id}">Lire</a><time datetime="2026-10-12">12 octobre 2026</time></article>`;
const popup = (content: string) => `<div id="cookies" role="dialog">Cookies
  <button id="accept-cookies">Accepter</button></div><main id="articles"></main>
  <script>document.querySelector('#accept-cookies').onclick = async () => {
    await fetch('/consent', {method:'POST',body:'accepted=true'});
    document.cookie='consent=accepted; path=/';
    document.querySelector('#cookies').remove();
    document.querySelector('#articles').innerHTML=${JSON.stringify(content)};
  };</script>`;

test("limits consent POSTs to the active page/frame origins and eligible resource types", () => {
  const origins = new Set(["https://publisher.example", "https://cmp.example"]);
  expect(consentPostAllowed("https://cmp.example/choice", "POST", "fetch", origins)).toBe(true);
  expect(consentPostAllowed("https://publisher.example/choice", "POST", "Document", origins)).toBe(
    true,
  );
  expect(consentPostAllowed("https://other.example/choice", "POST", "fetch", origins)).toBe(false);
  expect(consentPostAllowed("https://cmp.example/choice", "PUT", "fetch", origins)).toBe(false);
  expect(consentPostAllowed("https://cmp.example/choice", "POST", "script", origins)).toBe(false);
  expect(consentPostAllowed("https://cmp.example/choice", "POST", "fetch", new Set())).toBe(false);
});

test("only scraping analysis accepts the optional nonempty consent selector", () => {
  expect(
    selectorAnalysisInputSchema.parse({
      kind: "SCRAPING",
      url: "https://example.com/",
      cookieConsentSelector: " #accept ",
    }).cookieConsentSelector,
  ).toBe("#accept");
  for (const kind of ["RSS_LINK", "JOURNAL_LOGIN"])
    expect(
      selectorAnalysisInputSchema.safeParse({
        kind,
        url: "https://example.com/",
        cookieConsentSelector: "#accept",
      }).success,
    ).toBe(false);
});

test("clicks a visible consent button inside an iframe and resets temporary permissions", async () => {
  const context = await browser.createBrowserContext();
  try {
    const page = await createScrapingPage(browser, {}, context);
    await interceptRequests(page, async (request) =>
      request.respond({
        contentType: "text/html",
        body:
          new URL(request.url()).hostname === "cmp.example"
            ? '<div id="cookies"><button id="accept-cookies" onclick="parent.postMessage(\'accepted\',\'*\')">Refuser</button></div>'
            : '<iframe src="https://cmp.example/consent"></iframe><script>onmessage=()=>document.querySelector("iframe").remove()</script>',
      }),
    );
    await navigateScrapingPage(page, "https://publisher.example/");
    const calls: string[][] = [];
    expect(
      await dismissCookieConsent(page, "#accept-cookies", {
        onAction: (origins) => calls.push([...origins]),
      }),
    ).toBe(true);
    expect(calls).toEqual([["https://publisher.example", "https://cmp.example"], []]);
    expect(await page.$$eval("iframe", (elements) => elements.length)).toBe(0);
  } finally {
    await context.close();
  }
}, 30000);

test("an absent popup is harmless, but invalid, ambiguous and stuck buttons are explicit failures", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<main><h2>Articles déjà accessibles</h2></main>");
    expect(await dismissCookieConsent(page, "#accept-cookies")).toBe(false);
    await expect(dismissCookieConsent(page, "??")).rejects.toMatchObject({
      code: "INVALID_COOKIE_CONSENT_SELECTOR",
    });
    await page.setContent(
      '<button class="cookie" onclick="window.clicked=true">Accepter</button><button class="cookie">Refuser</button>',
    );
    await expect(dismissCookieConsent(page, ".cookie")).rejects.toMatchObject({
      code: "INVALID_COOKIE_CONSENT_SELECTOR",
    });
    expect(
      await page.evaluate(() => (window as unknown as { clicked?: boolean }).clicked),
    ).toBeUndefined();
    await page.setContent('<div id="cookies"><button id="accept-cookies">Accepter</button></div>');
    await expect(dismissCookieConsent(page, "#accept-cookies")).rejects.toMatchObject({
      code: "COOKIE_CONSENT_FAILED",
    });
  } finally {
    await page.close();
  }
}, 20000);

test("pagination applies consent before extraction and reuses its cookie on subsequent pages", async () => {
  const requests: { url: string; method?: string; cookie?: string; body?: string }[] = [];
  const service = new ScrapingService(async (url, options) => {
    requests.push({ url, method: options?.method, cookie: options?.cookie, body: options?.body });
    if (url.endsWith("/consent")) return "{}";
    const page = Number(new URL(url).searchParams.get("page"));
    return page === 1 ? popup(article("1")) : page === 2 ? article("2") : "<main></main>";
  });
  const config: ScrapingConfig = {
    ...base,
    mode: "PAGINATE",
    pagination: { strategy: "QUERY_PARAM", queryParam: "page", startPage: 1 },
  };
  const result = await service.collect("https://publisher.example/news", config);
  expect(result.articles.map((item) => item.title)).toEqual(["Article 1", "Article 2"]);
  expect(requests.filter((item) => item.url.endsWith("/consent"))).toEqual([
    expect.objectContaining({ method: "POST", body: "accepted=true" }),
  ]);
  expect(requests.find((item) => item.url.endsWith("page=2"))?.cookie).toContain(
    "consent=accepted",
  );
}, 30000);

test.each(["SCROLL", "LOAD_MORE"] as const)(
  "%s validation closes consent before checking required article selectors",
  async (mode) => {
    const service = new ScrapingService(async (url) =>
      url.endsWith("/consent") ? "{}" : popup(article("first")),
    );
    const config: ScrapingConfig = {
      ...base,
      mode,
      ...(mode === "SCROLL"
        ? { scroll: { maxScrolls: 0, waitAfterScrollMs: 100 } }
        : { loadMore: { buttonSelector: "#more", waitTimeoutMs: 1000 } }),
    };
    let checked = false;
    await service.validateFirstPage("https://publisher.example/news", config, (diagnostic) => {
      expect(diagnostic.withTitle).toBe(1);
      expect(diagnostic.withLink).toBe(1);
      checked = true;
    });
    expect(checked).toBe(true);
  },
  30000,
);

test("selector analysis closes a configured popup before producing the public HTML snapshot", async () => {
  const result = await renderPublicSelectorPage(
    "https://publisher.example/news",
    async (url) => ({
      url,
      status: 200,
      cookies: [],
      text: url.endsWith("/consent") ? "{}" : popup(article("IA")),
      contentType: url.endsWith("/consent") ? "application/json" : "text/html",
    }),
    undefined,
    { cookieConsentSelector: base.cookieConsentSelector },
  );
  expect(result.html).toContain("Article IA");
  expect(result.html).not.toContain('<div id="cookies"');
}, 30000);

test("handles a consent popup that appears after the browser verification finishes", async () => {
  const content = article("after-verification");
  const consentMarkup =
    '<div id="cookies">Cookies<button id="accept-cookies">Refuser</button></div>';
  const service = new ScrapingService(
    async () => `<p>vérifie votre navigateur...</p><script>
      setTimeout(() => {
        document.body.innerHTML = ${JSON.stringify(consentMarkup)};
        document.querySelector('#accept-cookies').onclick = () => {
          document.body.innerHTML = ${JSON.stringify(content)};
        };
      }, 3500);
    </script>`,
    undefined,
    { verificationWaitMs: 5000 },
  );
  const result = await service.collect("https://publisher.example/news", {
    ...base,
    mode: "SCROLL",
    scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
  });
  expect(result.articles[0]?.title).toBe("Article after-verification");
}, 30000);
