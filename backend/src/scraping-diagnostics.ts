import type { Page } from "puppeteer";
import type { ScrapingConfig } from "@dailybrief/shared";

export type ScrapingPageDiagnostic = {
  articleBlocks: number;
  withTitle: number;
  withLink: number;
  withDate: number;
  loadMoreButtons: number;
  pageProtection: boolean;
  consentVisible: boolean;
  pageTitleMatches: number;
  pageLinkMatches: number;
  pageDateMatches: number;
  pageButtonMatches: number;
};

/** Counts only: no HTML, article text, credentials or cookies leave the browser. */
export function inspectScrapingPage(
  page: Page,
  config: ScrapingConfig,
): Promise<ScrapingPageDiagnostic> {
  return page.evaluate((config) => {
    const blocks = [...document.querySelectorAll(config.articleSelector)];
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        element.getClientRects().length > 0
      );
    };
    let loadMoreButtons = 0;
    // The collector reports invalid button selectors with its dedicated error code.
    try {
      if (config.loadMore)
        loadMoreButtons = [...document.querySelectorAll(config.loadMore.buttonSelector)].filter(
          visible,
        ).length;
    } catch {
      /* Keep the existing button validation responsible for this field. */
    }
    // Some verification interstitials have no CAPTCHA iframe or known provider IDs.
    // Inspect a short, otherwise empty page only; never classify an article quoting
    // a verification message as a protection screen. No page text is returned/logged.
    const text = (document.body?.innerText ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const browserVerification =
      text.length > 0 &&
      text.length <= 1000 &&
      !document.querySelector("a[href], article, h1, h2, h3, h4") &&
      /\b(?:verifie votre navigateur|verifions votre navigateur|verification (?:de votre|du) navigateur|checking your browser|verifying your browser)\b/.test(
        text,
      );
    return {
      articleBlocks: blocks.length,
      withTitle: blocks.filter((block) =>
        block.querySelector(config.titleSelector)?.textContent?.trim(),
      ).length,
      withLink: blocks.filter((block) =>
        block.querySelector(config.linkSelector)?.getAttribute("href")?.trim(),
      ).length,
      withDate: config.dateSelector
        ? blocks.filter(
            (block) =>
              block.matches(config.dateSelector!) || block.querySelector(config.dateSelector!),
          ).length
        : 0,
      loadMoreButtons,
      pageProtection:
        browserVerification ||
        [
          ...document.querySelectorAll(
            '#challenge-form, #cf-challenge-running, #captcha, .g-recaptcha, iframe[src*="captcha-delivery.com/"], iframe[src*="challenges.cloudflare.com/"]',
          ),
        ].some(visible),
      consentVisible: [
        ...document.querySelectorAll(
          "#didomi-popup, #didomi-popup-container, #onetrust-banner-sdk, .gdpr-lmd-wall",
        ),
      ].some(visible),
      pageTitleMatches: document.querySelectorAll(config.titleSelector).length,
      pageLinkMatches: document.querySelectorAll(config.linkSelector).length,
      pageDateMatches: config.dateSelector
        ? document.querySelectorAll(config.dateSelector).length
        : 0,
      pageButtonMatches: config.loadMore
        ? (() => {
            try {
              return document.querySelectorAll(config.loadMore.buttonSelector).length;
            } catch {
              return 0;
            }
          })()
        : 0,
    };
  }, config);
}
