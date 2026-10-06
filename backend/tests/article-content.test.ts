import { test, expect } from "bun:test";
import {
  ArticleContentService,
  extractArticleContent,
  MAX_ARTICLE_CHARS,
} from "../src/article-content";

const paragraphs = [
  "Les informations détaillées de cet article complètent le court extrait du flux. ".repeat(8),
  "La deuxième section précise les conditions et les dates des mesures présentées. ".repeat(8),
  "La dernière section comporte une information finale essentielle à conserver dans le résumé.",
];
const page = `<html><head><title>Article de test</title><script>throw new Error("must not execute")</script></head><body>
  <header><nav>Navigation inutile</nav></header><main><article><h1>Article complet</h1>
  <p>${paragraphs[0]}</p><h2>Conditions</h2><p>${paragraphs[1]}</p><h2>Conclusion</h2><p>${paragraphs[2]}</p>
  </article></main><aside>Publicité inutile</aside><footer>Copyright inutile</footer></body></html>`;

test("extracts the whole article with headings and excludes navigation, ads and scripts", () => {
  const content = extractArticleContent(page, "https://example.com/article");
  expect(content).toContain(paragraphs[0]!.trim());
  expect(content).toContain("Conditions");
  expect(content).toContain(paragraphs[2]!);
  for (const excluded of [
    "Navigation inutile",
    "Publicité inutile",
    "Copyright inutile",
    "must not execute",
  ])
    expect(content).not.toContain(excluded);
});
test("supports JSON-LD articleBody when it contains the most complete text", () => {
  const body = paragraphs.join(" ");
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "NewsArticle", articleBody: body }] })}</script></head><body><p>Présentation courte</p></body></html>`;
  expect(extractArticleContent(html, "https://example.com/article")).toBe(
    body.replace(/\s+/g, " ").trim(),
  );
});
test("rejects empty, protected and JavaScript-only pages instead of summarizing a teaser", () => {
  for (const html of [
    "",
    "<html><body><div id='root'></div></body></html>",
    "<html><head><title>Just a moment...</title></head><body>" + paragraphs[0] + "</body></html>",
    "<html><body><p>Connectez-vous pour lire cet article.</p></body></html>",
  ])
    expect(() => extractArticleContent(html, "https://example.com/article")).toThrow();
});
test("rejects oversized articles without silently losing their end", () => {
  expect(() =>
    extractArticleContent(
      `<article><p>${"texte ".repeat(Math.ceil(MAX_ARTICLE_CHARS / 6) + 1)}</p></article>`,
      "https://example.com/article",
    ),
  ).toThrow("200 000");
});
test("the article downloader uses the linked page and retains the shared private address protection", async () => {
  const urls: string[] = [];
  const service = new ArticleContentService(async (url) => {
    urls.push(url);
    return page;
  });
  expect(await service.fetch("https://example.com/article")).toContain(paragraphs[2]!);
  expect(urls).toEqual(["https://example.com/article"]);
  await expect(service.fetch(null)).rejects.toMatchObject({ code: "ARTICLE_URL_MISSING" });
  await expect(new ArticleContentService().fetch("http://127.0.0.1/private")).rejects.toMatchObject(
    { code: "UNSAFE_URL" },
  );
});
