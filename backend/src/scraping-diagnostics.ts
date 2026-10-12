import type { Page } from "playwright";
import type { ScrapingConfig } from "@dailybrief/shared";

export type ScrapingPageDiagnostic = {
  articleBlocks: number;
  withTitle: number;
  withLink: number;
  withDate: number;
  loadMoreButtons: number;
  pageProtection: boolean;
  consentVisible: boolean;
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
      pageProtection: [
        ...document.querySelectorAll(
          '#challenge-form, #cf-challenge-running, #captcha, .g-recaptcha, iframe[src*="captcha-delivery.com/"], iframe[src*="challenges.cloudflare.com/"]',
        ),
      ].some(visible),
      consentVisible: [
        ...document.querySelectorAll(
          "#didomi-popup, #didomi-popup-container, #onetrust-banner-sdk",
        ),
      ].some(visible),
    };
  }, config);
}
