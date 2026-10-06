import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { load } from "cheerio";
import { AppError } from "./errors";
import { fetchRemoteText, type FetchText } from "./network";
import { plainText } from "./rss";

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
  if (
    !$("body").text().trim() ||
    /^(just a moment|access denied|attention required|accès refusé|robot verification)/i.test(
      $("title").text().trim(),
    ) ||
    $("#challenge-form, #cf-challenge-running, .g-recaptcha, #captcha").length
  )
    throw new AppError(
      422,
      "La page de l'article est vide ou bloquée par une protection d'accès.",
      "ARTICLE_CONTENT_UNAVAILABLE",
    );

  const bodies: string[] = [];
  $('script[type="application/ld+json"]').each((_index, node) => {
    try {
      bodies.push(...structuredArticleBody(JSON.parse($(node).text())));
    } catch {
      // Invalid optional metadata must not prevent extraction of the HTML article.
    }
  });
  $(
    'script, style, noscript, nav, footer, aside, form, dialog, [hidden], [aria-hidden="true"], [role="navigation"], [role="complementary"]',
  ).remove();
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
      "Aucun texte d'article suffisamment complet n'a été trouvé sur cette page. Elle peut nécessiter JavaScript, une connexion ou un abonnement.",
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
  constructor(private fetchText: FetchText = fetchRemoteText) {}
  async fetch(url: string | null): Promise<string> {
    if (!url)
      throw new AppError(
        422,
        "Cet article n'a pas de lien vers sa page complète.",
        "ARTICLE_URL_MISSING",
      );
    return extractArticleContent(await this.fetchText(url), url);
  }
}
