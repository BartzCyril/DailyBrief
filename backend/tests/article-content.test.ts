import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { ArticleBrowser } from "../src/article-browser";
import { fetchRemotePage, type RemotePage, type RemotePageOptions } from "../src/network";
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
const gate = readFileSync(
  new URL("./fixtures/vie-publique-browser-gate.html", import.meta.url),
  "utf8",
);

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
test("identifies the exact JavaScript redirect supplied by the user instead of blaming article length", () => {
  try {
    extractArticleContent(gate, "https://www.vie-publique.fr/loi/example");
    throw new Error("Expected a browser requirement");
  } catch (error) {
    expect(error).toMatchObject({ code: "ARTICLE_REQUIRES_BROWSER" });
  }
});
test("preserves reader-expandable article sections but excludes unrelated hidden content", () => {
  const html = `<main><article><h1>Loi de test</h1><button aria-controls="measures" aria-expanded="false">Mesures</button><section id="measures" class="fr-collapse" hidden aria-hidden="true" style="display:none"><p>${paragraphs[0]}</p><p>${paragraphs[2]}</p></section><div hidden>Unrelated hidden content</div></article></main>`;
  const content = extractArticleContent(html, "https://example.com/article");
  expect(content).toContain(paragraphs[2]!);
  expect(content).not.toContain("Unrelated hidden content");
});
test("extracts explicit CMS article bodies without requiring Readability to recognize the template", () => {
  const html = `<main><div class="field--name-body"><div>${paragraphs.join(" ")}</div></div><aside>Other links</aside></main>`;
  expect(extractArticleContent(html, "https://example.com/article")).toContain(paragraphs[2]!);
});
test("keeps all sibling sections of a single article rather than selecting only its introduction", () => {
  const sections = Array.from(
    { length: 6 },
    (_, i) =>
      `<section><h2>Mesure ${i}</h2><p>${paragraphs[1]} Information spécifique ${i}.</p></section>`,
  ).join("");
  const html = `<main><nav>Fil d'Ariane</nav><h1>Projet de loi</h1><div class="field--name-body"><p>${paragraphs[0]}</p></div><div class="fr-accordions-group">${sections}</div><aside><p>${"Articles recommandés. ".repeat(150)}</p></aside></main>`;
  const content = extractArticleContent(html, "https://example.com/article");
  expect(content).toContain(paragraphs[0]!.trim());
  for (let i = 0; i < 6; i++) expect(content).toContain(`Information spécifique ${i}.`);
  expect(content).not.toContain("Articles recommandés");
  expect(content).not.toContain("Fil d'Ariane");
});
test("does not combine a main region containing multiple independent articles", () => {
  const html = `<main><h1>Actualités</h1><article><p>${paragraphs[0]}</p></article><article><p>${paragraphs[1]}</p></article></main>`;
  const content = extractArticleContent(html, "https://example.com/news");
  expect(content.includes(paragraphs[0]!.trim()) && content.includes(paragraphs[1]!.trim())).toBe(
    false,
  );
});
test("assembles the Drupal fields reported on Vie publique in order without duplicates or associated cards", () => {
  // Synthetic content using the six body fields and nested recommendation layout
  // reported by the user; this is not a captured HTML page from Vie publique.
  const bodies = [1256, 1946, 1554, 1938, 1318, 1001].map(
    (length, i) =>
      `Contenu de la section ${i}. ${"Une mesure détaillée du projet de loi. ".repeat(Math.ceil(length / 39))} Fin de la section ${i}.`,
  );
  const related = `<div class="field--name-field-contenu-associe-interne"><h2>Article recommandé</h2><span class="field--name-field-chapo">${"Un extrait d'un autre article. ".repeat(30)}</span></div>`;
  const sections = bodies
    .map(
      (body, i) =>
        `<div><h2>Titre de section ${i}</h2><div class="field--name-field-corps-de-texte"><p>${body}</p></div>${i % 2 === 0 ? related : ""}</div>`,
    )
    .join("");
  const html = `<main id="contenu"><h1>Projet de loi de finances pour 2027</h1><span class="field--name-field-chapo">Introduction du projet de loi.</span><span class="field--name-field-intro-historique">Historique parlementaire.</span><span class="field--name-field-where-we-are-">Présentation au Conseil des ministres.</span><div class="field--name-field-bloc-paragraphe">${sections}</div><div><h2>Autres actualités</h2><p>${"Contenu hors article. ".repeat(1000)}</p></div></main>`;
  const messages: string[] = [];
  const content = extractArticleContent(
    html,
    "https://www.vie-publique.fr/loi/example",
    (message) => messages.push(message),
  );
  expect(content).toStartWith(
    "Projet de loi de finances pour 2027 Introduction du projet de loi. Historique parlementaire. Présentation au Conseil des ministres.",
  );
  let previous = -1;
  for (let i = 0; i < 6; i++) {
    expect(content).toContain(bodies[i]!.replace(/\s+/g, " ").trim());
    expect(content.split(`Titre de section ${i}`)).toHaveLength(2);
    const position = content.indexOf(`Titre de section ${i}`);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
  expect(content).toEndWith("Fin de la section 5.");
  expect(content.length).toBeGreaterThan(9000);
  for (const excluded of [
    "Article recommandé",
    "Un extrait d'un autre article",
    "Contenu hors article",
  ])
    expect(content).not.toContain(excluded);
  expect(messages[0]).toContain("6 blocs de texte");
});
test("waits for delayed article sections even when the initial introduction already exceeds 200 characters", async () => {
  const browser = new ArticleBrowser(async () => ({
    status: 200,
    cookies: [],
    text: `<main><article><h1>Article</h1><p>${paragraphs[0]}</p><div id="rest"></div></article></main><script>setTimeout(()=>document.querySelector('#rest').innerHTML=${JSON.stringify(`<h2>Suite</h2><p>${paragraphs[1]}</p><p>${paragraphs[2]}</p>`)},1200);</script>`,
  }));
  const rendered = await browser.render("https://fixture.example/delayed");
  expect(extractArticleContent(rendered.html, rendered.url)).toContain(paragraphs[2]!);
}, 20000);
test("real Chromium follows the supplied JS redirect, preserves multiple server cookies and executes the final page", async () => {
  const requests: { url: string; options?: RemotePageOptions }[] = [];
  const browser = new ArticleBrowser(async (url, options): Promise<RemotePage> => {
    requests.push({ url, options });
    expect(options?.followRedirects).toBe(false);
    if (!new URL(url).pathname.startsWith("/redirect_"))
      return {
        status: 200,
        text: gate,
        cookies: ["gate=server; Path=/; HttpOnly; Secure", "second=value; Path=/; Secure"],
        contentType: "text/html",
      };
    expect(options?.cookie).toContain("gate=server");
    expect(options?.cookie).toContain("second=value");
    return {
      status: 200,
      cookies: [],
      text: `<html><body><main><article><h1>Article final</h1><div id="content"></div></article></main><script>document.cookie='client=enabled; path=/'; setTimeout(()=>document.querySelector('#content').innerHTML=${JSON.stringify(`<p>${paragraphs.join(" ")}</p>`)},100);</script></body></html>`,
      contentType: "text/html; charset=iso-8859-1",
    };
  });
  const messages: string[] = [];
  const service = new ArticleContentService(async () => gate, browser);
  const content = await service.fetch("https://www.vie-publique.fr/loi/example", (message) =>
    messages.push(message),
  );
  expect(content).toContain(paragraphs[2]!);
  expect(requests).toHaveLength(2);
  expect(messages[0]).toContain("Chromium");
  expect(requests[0]?.options?.userAgent).toContain("Chrome");
}, 20000);
test("the browser retains cookies over HTTP redirects and isolates browser contexts", async () => {
  let calls = 0;
  const browser = new ArticleBrowser(async (url, options) => {
    calls++;
    if (url.endsWith("/start")) {
      expect(options?.cookie).toBeUndefined();
      return {
        status: 302,
        location: "/final",
        cookies: ["session=unique; Path=/; Secure"],
        text: "",
      };
    }
    expect(options?.cookie).toContain("session=unique");
    return { status: 200, cookies: [], text: page };
  });
  for (let i = 0; i < 2; i++)
    expect((await browser.render("https://fixture.example/start")).url).toBe(
      "https://fixture.example/final",
    );
  expect(calls).toBe(4);
}, 20000);
test("browser JS navigations still hit the private-address guard before any content or AI is used", async () => {
  const browser = new ArticleBrowser(async (url) => {
    if (url === "https://fixture.example/start")
      return {
        status: 200,
        text: `<script>location.href='http://127.0.0.1/private';</script>`,
        cookies: [],
      };
    return fetchRemotePage(url);
  });
  await expect(browser.render("https://fixture.example/start")).rejects.toMatchObject({
    code: "UNSAFE_URL",
  });
}, 20000);
test("bounds redirect loops without following an uncontrolled native HTTP redirect", async () => {
  let calls = 0;
  const browser = new ArticleBrowser(async () => {
    calls++;
    return { status: 302, location: `/loop-${calls}`, cookies: [], text: "" };
  });
  await expect(browser.render("https://fixture.example/start")).rejects.toMatchObject({
    code: "REDIRECT_LIMIT",
  });
  expect(calls).toBe(8);
}, 20000);
