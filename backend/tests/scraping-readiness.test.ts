import { expect, test } from "bun:test";
import type { ScrapingConfig } from "@dailybrief/shared";
import { ScrapingService } from "../src/scraping";
import type { FetchText } from "../src/network";
const fixtureService = (fetch: FetchText) =>
  new ScrapingService(fetch, undefined, { verificationWaitMs: 0 });
import type { ScrapingPageDiagnostic } from "../src/scraping-diagnostics";

const config: ScrapingConfig = {
  articleSelector: ".teaser",
  titleSelector: ".teaser__title",
  linkSelector: ".teaser__link",
  dateSelector: ".meta__date",
  mode: "LOAD_MORE",
  loadMore: { buttonSelector: "#js-more-teaser", waitTimeoutMs: 1000 },
};
const teaser = (id: string) =>
  `<article class="teaser"><h3 class="teaser__title">Article ${id}</h3><a class="teaser__link" href="/${id}">Lire</a><span class="meta__date">12 octobre 2026</span></article>`;

test("extracts the supplied teaser selectors and the next batch without filtering dates in the form preview", async () => {
  const service = fixtureService(
    async () =>
      `${teaser("first")}<button id="js-more-teaser">Plus</button><script>document.querySelector('button').onclick=()=>{document.querySelector('button').insertAdjacentHTML('beforebegin',${JSON.stringify(teaser("next"))});document.querySelector('button').remove();}</script>`,
  );
  const result = await service.collect("https://fixture.example/patrimoine/", config);
  expect(result.articles.map((article) => article.title)).toEqual([
    "Article first",
    "Article next",
  ]);
  expect(result.articles[0]?.url).toBe("https://fixture.example/first");
  expect(result.articles[0]?.publishedAt).toBe("2026-10-12T00:00:00.000Z");
}, 15000);

test("waits for cards populated by delayed JavaScript after network idle", async () => {
  const service = fixtureService(
    async () =>
      `<main id="list"></main><script>setTimeout(()=>document.querySelector('#list').innerHTML=${JSON.stringify(teaser("late"))},1200)</script>`,
  );
  const result = await service.collect("https://fixture.example/patrimoine/", {
    ...config,
    mode: "SCROLL",
    loadMore: undefined,
    scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
  });
  expect(result.articles.map((article) => article.title)).toEqual(["Article late"]);
}, 15000);

test("reports a protection page rather than blaming article selectors", async () => {
  const service = fixtureService(
    async () => '<main><form id="challenge-form">Vérification</form></main>',
  );
  await expect(
    service.collect("https://fixture.example/patrimoine/", config),
  ).rejects.toMatchObject({ code: "SCRAPING_PAGE_BLOCKED" });
}, 15000);

test("a CAPTCHA widget alongside valid articles does not prevent their extraction", async () => {
  const service = fixtureService(async () => `${teaser("public")}<div class="g-recaptcha"></div>`);
  expect(
    (await service.collect("https://fixture.example/patrimoine/", config)).articles,
  ).toHaveLength(1);
}, 15000);

test("recognizes the supplied browser-verification screen without CAPTCHA markers", async () => {
  const service = fixtureService(
    async () =>
      '<div><img alt="Logo de l’entreprise"><p>vérifie votre navigateur...</p><div class="spinner"></div></div>',
  );
  let observed: ScrapingPageDiagnostic | undefined;
  await expect(
    service.validateFirstPage("https://fixture.example/patrimoine/", config, (value) => {
      observed = value;
    }),
  ).rejects.toMatchObject({ code: "SCRAPING_PAGE_BLOCKED" });
  expect(observed).toMatchObject({ articleBlocks: 0, pageProtection: true });
  expect(JSON.stringify(observed)).not.toContain("navigateur");
}, 15000);

test("does not misclassify an article quoting the browser-verification message", async () => {
  const service = fixtureService(
    async () => teaser("public") + "<p>Le site vérifie votre navigateur...</p>",
  );
  let observed: ScrapingPageDiagnostic | undefined;
  await service.validateFirstPage("https://fixture.example/patrimoine/", config, (value) => {
    observed = value;
  });
  expect(observed?.pageProtection).toBe(false);
}, 15000);

test("first-page diagnosis counts selectors without clicking the button or exposing content", async () => {
  let diagnostic: ScrapingPageDiagnostic | undefined;
  const service = fixtureService(
    async () =>
      `${teaser("public")}<button id="js-more-teaser" onclick="throw Error('must not click')">Plus</button>`,
  );
  await service.validateFirstPage("https://fixture.example/patrimoine/", config, (value) => {
    diagnostic = value;
  });
  expect(diagnostic).toEqual({
    articleBlocks: 1,
    withTitle: 1,
    withLink: 1,
    withDate: 1,
    loadMoreButtons: 1,
    pageProtection: false,
    pageTitleMatches: 1,
    pageLinkMatches: 1,
    pageDateMatches: 1,
    pageButtonMatches: 1,
  });
  expect(JSON.stringify(diagnostic)).not.toContain("Article public");
}, 15000);

test("missing article blocks remain an extraction error regardless of overlays", async () => {
  for (const [markup, expected] of [
    ["<main>Rubrique vide</main>", "sélecteur des articles"],
    ['<div id="didomi-popup">Choisissez vos préférences</div>', "sélecteur des articles"],
  ]) {
    const service = new ScrapingService(async () => markup!);
    let diagnostic: ScrapingPageDiagnostic | undefined;
    const error = await service
      .validateFirstPage("https://fixture.example/patrimoine/", config, (value) => {
        diagnostic = value;
      })
      .catch((error: Error) => error);
    expect(error).toMatchObject({ code: "EMPTY_SCRAPING" });
    expect((error as Error).message).toContain(expected!);
    expect(diagnostic?.articleBlocks).toBe(0);
  }
}, 15000);
