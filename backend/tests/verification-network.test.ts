import { expect, test } from "bun:test";
import { verificationPostAllowed } from "../src/verification-network";
import { ScrapingService } from "../src/scraping";
import type { ScrapingConfig } from "@dailybrief/shared";

test("verification POSTs are restricted to the verification phase, AJAX, the site and exact known HTTPS providers", () => {
  const origin = "https://fixture.example";
  const allowed = (url: string, verifying = true, method = "POST", type = "fetch") =>
    verificationPostAllowed(url, method, type, verifying, origin);
  expect(allowed(`${origin}/verify`)).toBe(true);
  expect(allowed("https://geo.captcha-delivery.com/verify")).toBe(true);
  expect(allowed("https://api-js.datadome.co/js/", true, "POST", "XHR")).toBe(true);
  expect(allowed("https://challenges.cloudflare.com/verify")).toBe(true);
  for (const url of [
    "http://geo.captcha-delivery.com/verify",
    "https://geo.captcha-delivery.com:8443/verify",
    "https://geo.captcha-delivery.com.evil.example/verify",
    "https://other.example/verify",
    "https://user:secret@geo.captcha-delivery.com/verify",
  ])
    expect(allowed(url)).toBe(false);
  expect(allowed("https://geo.captcha-delivery.com/verify", false)).toBe(false);
  expect(allowed("https://geo.captcha-delivery.com/verify", true, "PUT")).toBe(false);
  expect(allowed("https://geo.captcha-delivery.com/verify", true, "POST", "document")).toBe(false);
});

test("retries a verification whose native provider POST was initially filtered and restores the normal request policy", async () => {
  const source = "https://fixture.example/patrimoine/";
  const provider = "https://geo.captcha-delivery.com/verification";
  const article =
    '<article class="teaser"><h2 class="teaser__title">Article accessible</h2><a class="teaser__link" href="/article">Lire</a><time class="meta__date">12 octobre 2026</time></article>';
  const markup = `<div><img src="/verification-logo.png"><p>vérifie votre navigateur...</p></div><script>
    fetch(${JSON.stringify(provider)}, {method:'POST',mode:'no-cors',body:'browser-proof'})
      .then(()=>document.body.innerHTML=${JSON.stringify(article)})
      .catch(()=>{});
  </script>`;
  const requests: { url: string; method: string }[] = [];
  const service = new ScrapingService(
    async (url, options) => {
      requests.push({ url, method: options?.method ?? "GET" });
      return url === source ? markup : "ok";
    },
    undefined,
    { verificationWaitMs: 5000 },
  );
  const config: ScrapingConfig = {
    articleSelector: ".teaser",
    titleSelector: ".teaser__title",
    linkSelector: ".teaser__link",
    dateSelector: ".meta__date",
    mode: "SCROLL",
    scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
  };
  let protectedAgain = false;
  await service.validateFirstPage(source, config, async (diagnostic, page) => {
    expect(diagnostic.withTitle).toBe(1);
    protectedAgain = await page.evaluate(async (provider) => {
      try {
        await fetch(provider, { method: "POST", mode: "no-cors", body: "must-be-blocked" });
        return false;
      } catch {
        return true;
      }
    }, provider);
  });
  expect(requests.filter((request) => request.url === source)).toHaveLength(2);
  expect(requests.filter((request) => request.url === provider)).toEqual([
    { url: provider, method: "POST" },
  ]);
  expect(requests.some((request) => request.url.endsWith("verification-logo.png"))).toBe(true);
  expect(protectedAgain).toBe(true);
}, 30000);
