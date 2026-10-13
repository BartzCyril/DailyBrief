import { expect, test } from "bun:test";
import { ScrapingService } from "../src/scraping";
import { readScrapingVerificationWait } from "../src/config";
import type { ScrapingConfig } from "@dailybrief/shared";

const config: ScrapingConfig = {
  articleSelector: ".teaser",
  titleSelector: ".teaser__title",
  linkSelector: ".teaser__link",
  dateSelector: ".meta__date",
  mode: "SCROLL",
  scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
};
const article =
  '<article class="teaser"><h2 class="teaser__title">Article public</h2><a class="teaser__link" href="/article">Lire</a><time class="meta__date" datetime="2026-10-12">12 octobre</time></article>';
const verification = "<div>vérifie votre navigateur...</div>";

test("wait configuration has a 30 second default and a two minute ceiling", () => {
  expect(readScrapingVerificationWait({})).toBe(30000);
  expect(readScrapingVerificationWait({ SCRAPING_VERIFICATION_WAIT_MS: "0" })).toBe(0);
  expect(readScrapingVerificationWait({ SCRAPING_VERIFICATION_WAIT_MS: "120000" })).toBe(120000);
  for (const value of ["-1", "120001", "1.5", "invalid"])
    expect(() => readScrapingVerificationWait({ SCRAPING_VERIFICATION_WAIT_MS: value })).toThrow();
});

test("continues extraction when a transient verification clears and retains the same temporary cookies", async () => {
  const service = new ScrapingService(
    async () => `${verification}<script>setTimeout(()=>{
    document.cookie='verification_completed=1;path=/';
    document.body.innerHTML=${JSON.stringify(article)};
  },1800)</script>`,
    undefined,
    { verificationWaitMs: 3000 },
  );
  let retainedCookie = false;
  await service.validateFirstPage(
    "https://fixture.example/patrimoine/",
    config,
    async (diagnostic, page) => {
      expect(diagnostic.withTitle).toBe(1);
      expect(diagnostic.pageProtection).toBe(false);
      retainedCookie = (await page.browserContext().cookies()).some(
        (cookie) => cookie.name === "verification_completed" && cookie.value === "1",
      );
    },
  );
  expect(retainedCookie).toBe(true);
}, 20000);

test("a persistent verification fails explicitly after the configured wait", async () => {
  const service = new ScrapingService(async () => verification, undefined, {
    verificationWaitMs: 500,
  });
  await expect(
    service.collect("https://fixture.example/patrimoine/", config),
  ).rejects.toMatchObject({
    code: "SCRAPING_PAGE_BLOCKED",
    message:
      "La page de vérification du navigateur est toujours présente après 0.5 seconde(s). Le site n'a pas rendu ses articles accessibles au navigateur de collecte.",
  });
}, 20000);

test("a verification on a later pagination page cannot become a successful partial collection", async () => {
  const service = new ScrapingService(
    async (url) => (new URL(url).searchParams.get("page") === "1" ? article : verification),
    undefined,
    { verificationWaitMs: 500 },
  );
  await expect(
    service.collect("https://fixture.example/patrimoine/", {
      ...config,
      mode: "PAGINATE",
      scroll: undefined,
      pagination: { strategy: "QUERY_PARAM", queryParam: "page", startPage: 1 },
    }),
  ).rejects.toMatchObject({ code: "SCRAPING_PAGE_BLOCKED" });
}, 20000);
