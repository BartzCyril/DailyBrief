import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { load } from "cheerio";
import { AppError } from "./errors";
import { fetchRemoteText, type FetchText } from "./network";
import { plainText } from "./rss";
import { ArticleBrowser } from "./article-browser";

export const MAX_ARTICLE_CHARS = 200000;

// Drupal's paragraph-based articles split the introduction and body across fields.
const PARAGRAPH_FIELDS =
  ".field--name-field-chapo, .field--name-field-intro-historique, .field--name-field-where-we-are-, .field--name-field-bloc-paragraphe, .field--name-field-corps-de-texte";

function regionText(html: string): string {
  const region = load(html);
  region("br").replaceWith(" ");
  region("p, li, h1, h2, h3, h4, tr, blockquote, div").append(" ");
  return region.text().replace(/\s+/g, " ").trim();
}

function structuredArticleBody(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(structuredArticleBody);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const types = Array.isArray(object["@type"]) ? object["@type"] : [object["@type"]];
  const bodies =
    types.some((type) => typeof type === "string" && /Article|BlogPosting/.test(type)) &&
    typeof object.articleBody === "string"
      ? [plainText(object.articleBody)]
      : [];
  return [...bodies, ...structuredArticleBody(object["@graph"])];
}

export function extractArticleContent(
  html: string,
  url: string,
  observer?: (message: string) => void,
): string {
  const $ = load(html);
  const scripts = $("script").text();
  const visible = load(html);
  visible("script, style, noscript").remove();
  if (
    visible("body").text().trim().length < 200 &&
    /(?:window\.)?location\s*(?:\.href\s*=|\.(?:assign|replace)\s*\()/.test(scripts)
  )
    throw new AppError(
      422,
      "Le site renvoie une redirection JavaScript au lieu de l'article et peut demander des cookies.",
      "ARTICLE_REQUIRES_BROWSER",
    );
  if (
    /^(just a moment|access denied|attention required|accès refusé|robot verification)/i.test(
      $("title").text().trim(),
    ) ||
    $("#challenge-form, #cf-challenge-running, .g-recaptcha, #captcha").length
  )
    throw new AppError(
      422,
      "Le site renvoie une page de protection d'accès ou de vérification au lieu de l'article.",
      "ARTICLE_ACCESS_BLOCKED",
    );

  const bodies: string[] = [];
  $('script[type="application/ld+json"]').each((_index, node) => {
    try {
      bodies.push(...structuredArticleBody(JSON.parse($(node).text())));
    } catch {
      // Invalid optional metadata must not prevent extraction of the HTML article.
    }
  });
  // Retain sections that a reader can expand, rather than treating them as irrelevant hidden text.
  const expandableIds = new Set(
    $("[aria-controls]")
      .toArray()
      .flatMap((node) => ($(node).attr("aria-controls") ?? "").split(/\s+/).filter(Boolean)),
  );
  $("[id]").each((_index, panel) => {
    if (!expandableIds.has($(panel).attr("id") ?? "")) return;
    $(panel).removeAttr("hidden aria-hidden");
    const style = $(panel).attr("style");
    if (style)
      $(panel).attr(
        "style",
        style.replace(
          /(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*;?/gi,
          "",
        ),
      );
  });
  $("details").attr("open", "");
  $(
    'script, style, noscript, nav, footer, aside, form, dialog, [hidden], [aria-hidden="true"], [role="navigation"], [role="complementary"]',
  ).remove();
  $(
    ".field--name-field-contenu-associe-interne, .field--name-field-contenu-associe-externe",
  ).remove();
  let paragraphContent = "";
  const main = $("main, [role='main']").first();
  const fields = main.length ? main.find(PARAGRAPH_FIELDS) : $(PARAGRAPH_FIELDS);
  if (fields.filter(".field--name-field-bloc-paragraphe").length) {
    const parts: string[] = [];
    const title = $("main h1, [role='main'] h1").first().text().replace(/\s+/g, " ").trim();
    if (title) parts.push(title);
    // Keep the parent paragraph group once, including section headings; do not
    // append its individual body fields again or mix in related article cards.
    fields.each((_index, node) => {
      if ($(node).parents(PARAGRAPH_FIELDS).length) return;
      parts.push(regionText($(node).html() ?? ""));
    });
    paragraphContent = parts.filter(Boolean).join(" ");
  }
  $(
    "[itemprop~='articleBody'], .field--name-body, .field--name-field-texte, .article-body, article, [role='article']",
  ).each((_index, node) => {
    bodies.push(regionText($(node).html() ?? ""));
  });
  // JSDOM does not execute scripts or load external resources with these defaults.
  const dom = new JSDOM($.html(), { url });
  try {
    const article = new Readability(dom.window.document, {
      charThreshold: 200,
      maxElemsToParse: 50000,
    }).parse();
    if (article?.content) {
      bodies.push(regionText(article.content));
    }
  } catch {
    if (paragraphContent.length < 200 && !bodies.some((body) => body.length >= 200))
      throw new AppError(
        422,
        "Le contenu de cette page ne peut pas être extrait.",
        "ARTICLE_EXTRACTION_FAILED",
      );
  } finally {
    dom.window.close();
  }
  // A known article structure is more reliable than Readability's scoring, which
  // may retain only the introduction or include unrelated recommendation cards.
  const content =
    paragraphContent.length >= 200
      ? paragraphContent
      : (bodies.sort((a, b) => b.length - a.length)[0] ?? "");
  if (content.length < 200)
    throw new AppError(
      422,
      "Le texte principal de l'article n'a pas été trouvé dans le HTML reçu.",
      "ARTICLE_CONTENT_UNAVAILABLE",
    );
  if (content.length > MAX_ARTICLE_CHARS)
    throw new AppError(
      413,
      "L'article dépasse la limite de 200 000 caractères ; aucun résumé partiel n'a été généré.",
      "ARTICLE_TOO_LARGE",
    );
  if (paragraphContent.length >= 200)
    observer?.(
      `Article structuré : ${fields.filter(".field--name-field-corps-de-texte").length} blocs de texte réunis avec les titres et l'introduction (${content.length} caractères).`,
    );
  return content;
}

export class ArticleContentService {
  constructor(
    private fetchText: FetchText = fetchRemoteText,
    private browser = new ArticleBrowser(),
  ) {}
  async fetch(url: string | null, observer?: (message: string) => void): Promise<string> {
    if (!url)
      throw new AppError(
        422,
        "Cet article n'a pas de lien vers sa page complète.",
        "ARTICLE_URL_MISSING",
      );
    const html = await this.fetchText(url);
    try {
      return extractArticleContent(html, url, observer);
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        ![
          "ARTICLE_REQUIRES_BROWSER",
          "ARTICLE_CONTENT_UNAVAILABLE",
          "ARTICLE_EXTRACTION_FAILED",
        ].includes(error.code)
      )
        throw error;
      observer?.(
        "Chargement de la page dans Chromium pour exécuter JavaScript et conserver les cookies du site.",
      );
      observer?.("Attente du chargement et de la stabilisation des sections de l'article.");
      const rendered = await this.browser.render(url);
      try {
        return extractArticleContent(rendered.html, rendered.url, observer);
      } catch (renderedError) {
        if (renderedError instanceof AppError && renderedError.code === "ARTICLE_REQUIRES_BROWSER")
          throw new AppError(
            422,
            "Le site continue à renvoyer une redirection JavaScript au lieu de l'article après le chargement navigateur.",
            "ARTICLE_BROWSER_BLOCKED",
          );
        throw renderedError;
      }
    }
  }
}
