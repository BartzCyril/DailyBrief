import { load } from "cheerio";
import { AppError } from "./errors";

function normalized(text: string) {
  return text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const refusalTitle =
  /\b(?:acces (?:restreint|refuse|interdit|bloque)|access (?:denied|restricted|blocked)|forbidden|commercial licen[cs]e required|ai licensing required|automated access blocked)\b/;
const automationRefusal =
  /\b(?:trafic.{0,100}(?:identifie|detecte).{0,50}(?:automatise|bot)|(?:acces|requetes?) automatise(?:s)?.{0,80}(?:refus|bloqu|interdit)|(?:automated|bot) (?:traffic|access|requests?).{0,100}(?:blocked|denied|restricted|identified|detected|requires?)|(?:traffic|access|requests?).{0,100}(?:identified|detected).{0,50}(?:automated|bot)|(?:ai training|automated access).{0,100}(?:commercial (?:agreement|licen[cs]e)|licensing required))\b/;
const subscriptionTitle =
  /\b(?:article reserve aux abonnes|reserve aux abonnes|abonnement requis|subscription required|subscriber[- ]only|payment required)\b/;
const subscriptionRequest =
  /\b(?:(?:abonnez[- ]vous|souscrivez|subscribe).{0,100}(?:lire|lecture|acceder|read|access)|(?:pour lire|pour acceder|to read|to access).{0,100}(?:abonnez|abonnement|subscribe|subscription)|(?:cet article|ce contenu).{0,100}(?:reserve aux abonnes|necessite un abonnement)|(?:this (?:article|content)).{0,100}(?:requires? (?:a |an )?subscription|subscribers? only)|(?:abonnement|subscription).{0,50}(?:requis|required))\b/;

function classifiedError(status: number, html?: string) {
  if (status === 402 && html) {
    // The transport already limits decoded bodies. Bound this entry point too,
    // and parse without executing any response scripts or loading resources.
    const $ = load(html.slice(0, 2 * 1024 * 1024));
    $("script, style, noscript, template, svg, iframe").remove();
    const titles = [$("title").first().text(), $("h1").first().text()].map(normalized);
    // DOM textContent joins adjacent blocks without a separator. Preserve their
    // reading boundaries so an adjoining heading cannot hide the refusal text.
    $("br").replaceWith(" ");
    $("h1, h2, h3, h4, h5, h6, p, div, form, li, tr, section, article, main, a").append(" ");
    const body = normalized($("body").text());

    if (titles.some((title) => refusalTitle.test(title)) && automationRefusal.test(body))
      return {
        message:
          "Le journal refuse cet accès automatisé à l'article (HTTP 402). La connexion au compte ne suffit pas à autoriser ce chargement.",
        code: "JOURNAL_ARTICLE_AUTOMATION_BLOCKED",
      };

    const paywall = normalized(
      $(
        ".paywall, .subscription-wall, .subscribe-wall, .subscriber-only, .restricted-content, [data-paywall]",
      ).text(),
    );
    if (
      (titles.some((title) => subscriptionTitle.test(title)) && subscriptionRequest.test(body)) ||
      subscriptionRequest.test(paywall)
    )
      return {
        message:
          "Le journal réclame un accès abonné pour cet article (HTTP 402). Vérifiez les droits d'accès de ce compte auprès du journal.",
        code: "JOURNAL_ARTICLE_SUBSCRIPTION_REQUIRED",
      };
  }

  return {
    message:
      Number.isInteger(status) && status >= 400 && status <= 599
        ? `Le journal a refusé le chargement de l'article avec la session authentifiée (HTTP ${status}).`
        : "Le journal a retourné une erreur HTTP lors du chargement de l'article avec la session authentifiée.",
    code: "JOURNAL_ARTICLE_HTTP_ERROR",
  };
}

/** This type only generates safe messages; response HTML can contain session data. */
export class JournalHttpError extends AppError {
  constructor(status: number, html?: string) {
    const error = classifiedError(status, html);
    super(422, error.message, error.code);
  }
}

export function journalHttpError(status: number, html?: string): JournalHttpError {
  return new JournalHttpError(status, html);
}
