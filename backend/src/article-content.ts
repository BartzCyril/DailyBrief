import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { load } from "cheerio";
import { AppError } from "./errors";
import { fetchRemoteText, type FetchText } from "./network";
import { plainText } from "./rss";
import { ArticleBrowser } from "./article-browser";

export const MAX_ARTICLE_CHARS = 200000;

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

export function extractArticleContent(html: string, url: string): string {
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
    "[itemprop~='articleBody'], .field--name-body, .field--name-field-texte, .article-body, article, [role='article']",
  ).each((_index, node) => {
    const region = load($(node).html() ?? "");
    region("br").replaceWith(" ");
    region("p, li, h1, h2, h3, h4, tr, blockquote, div").append(" ");
    bodies.push(region.text().replace(/\s+/g, " ").trim());
  });
  // JSDOM does not execute scripts or load external resources with these defaults.
  const dom = new JSDOM($.html(), { url });
  try {
    const article = new Readability(dom.window.document, {
      charThreshold: 200,
      maxElemsToParse: 50000,
    }).parse();
    if (article?.content) {
      const cleaned = load(article.content);
      cleaned("br").replaceWith(" ");
      cleaned("p, li, h1, h2, h3, h4, tr, blockquote").append(" ");
      bodies.push(cleaned.text().replace(/\s+/g, " ").trim());
    }
  } catch {
    throw new AppError(
      422,
      "Le contenu de cette page ne peut pas être extrait.",
      "ARTICLE_EXTRACTION_FAILED",
    );
  } finally {
    dom.window.close();
  }
  const content = bodies.sort((a, b) => b.length - a.length)[0] ?? "";
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
      return extractArticleContent(html, url);
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
      const rendered = await this.browser.render(url);
      try {
        return extractArticleContent(rendered.html, rendered.url);
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
