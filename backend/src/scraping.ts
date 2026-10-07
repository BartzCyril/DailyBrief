import { chromium, type Page } from "playwright";
import type { ArticlePreview, ScrapingConfig, SourcePreview } from "@dailybrief/shared";
import { scrapingSchema } from "../../shared/src/scraping";
import { fetchRemoteText, type FetchText } from "./network";
import { articleDate, articleUrl } from "./rss";
import { AppError } from "./errors";
import { ConcurrencyLimiter } from "./concurrency";
import { createHash } from "node:crypto";

export function paginationUrl(url: string, config: ScrapingConfig, page: number): string {
  const pagination = config.pagination!;
  if (pagination.strategy === "URL_TEMPLATE")
    return pagination.urlTemplate!.replaceAll("{page}", String(page));
  const target = new URL(url);
  target.searchParams.set(pagination.queryParam!, String(page));
  return target.href;
}
export function deduplicatePreviews(items: ArticlePreview[]): ArticlePreview[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = previewKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function previewKey(item: ArticlePreview): string {
  return item.url ?? `${item.title}:${item.description}`;
}
async function extract(page: Page, config: ScrapingConfig): Promise<ArticlePreview[]> {
  const entries = await page.evaluate(
    (config) =>
      Array.from(document.querySelectorAll(config.articleSelector)).map((element) => ({
        title: element.querySelector(config.titleSelector)?.textContent?.trim() ?? "",
        url: element.querySelector(config.linkSelector)?.getAttribute("href") ?? null,
        description: config.descriptionSelector
          ? (element.querySelector(config.descriptionSelector)?.textContent?.trim() ?? null)
          : null,
        publishedAt: config.dateSelector
          ? (element.querySelector(config.dateSelector)?.getAttribute("datetime") ??
            element.querySelector(config.dateSelector)?.textContent ??
            null)
          : null,
      })),
    config,
  );
  if (entries.length && !entries.some((item) => item.title))
    throw new AppError(
      422,
      "Aucun article avec un titre trouvé dans les blocs de cette page. Vérifiez le sélecteur du titre.",
      "INVALID_SCRAPING_EXTRACTION",
    );
  return entries
    .filter((item) => item.title)
    .map((item) => ({
      ...item,
      url: item.url ? articleUrl(item.url, page.url()) : null,
      publishedAt: item.publishedAt ? articleDate(item.publishedAt) : null,
    }));
}
export class ScrapingService {
  private limiter = new ConcurrencyLimiter(2);
  constructor(private fetchText: FetchText = fetchRemoteText) {}
  async collect(url: string, input: ScrapingConfig): Promise<SourcePreview> {
    return this.scrape(url, input, false);
  }
  async validateFirstPage(url: string, input: ScrapingConfig): Promise<void> {
    await this.scrape(url, input, true);
  }
  private async scrape(
    url: string,
    input: ScrapingConfig,
    firstPageOnly: boolean,
  ): Promise<SourcePreview> {
    const config = scrapingSchema.parse(input);
    return this.limiter.run(async () => {
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
      });
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      let timedOut = false;
      let networkError: unknown;
      const timer =
        config.mode === "SCROLL"
          ? setTimeout(() => {
              timedOut = true;
              void context.close();
            }, 45000)
          : undefined;
      try {
        // Fulfil every network request through the same DNS-pinned SSRF guard as RSS.
        await context.route("**/*", async (route) => {
          const request = route.request();
          if (
            request.method() !== "GET" ||
            ["image", "media", "font"].includes(request.resourceType())
          ) {
            await route.abort();
            return;
          }
          try {
            const body = await this.fetchText(request.url());
            const contentType =
              (
                {
                  document: "text/html",
                  script: "application/javascript",
                  stylesheet: "text/css",
                } as Record<string, string>
              )[request.resourceType()] ?? "application/json";
            await route.fulfill({ body, contentType });
          } catch (error) {
            if (request.isNavigationRequest()) networkError = error;
            await route.abort().catch(() => {});
          }
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const articles: ArticlePreview[] = [];
        const warnings: string[] = [];
        if (config.mode === "SCROLL") {
          await page.goto(url, { waitUntil: "networkidle" });
          articles.push(...(await extract(page, config)));
          for (let i = 0; i < (firstPageOnly ? 0 : config.scroll!.maxScrolls); i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(config.scroll!.waitAfterScrollMs);
            articles.push(...(await extract(page, config)));
          }
        } else {
          const seenPages = new Set<string>();
          const seenArticles = new Set<string>();
          for (let number = config.pagination!.startPage; ; number++) {
            await page.goto(paginationUrl(url, config, number), {
              waitUntil: "networkidle",
            });
            const entries = await extract(page, config);
            if (!entries.length) break;
            // Ignore ordering changes when a site repeats a page or cycles through
            // previous pages instead of honouring the requested page number.
            const fingerprint = createHash("sha256")
              .update(JSON.stringify(entries.map(previewKey).sort()))
              .digest("hex");
            if (seenPages.has(fingerprint)) {
              warnings.push(
                `Pagination arrêtée à la page ${number} : cette page répète des articles d'une page déjà parcourue.`,
              );
              break;
            }
            seenPages.add(fingerprint);
            for (const article of entries) {
              const key = previewKey(article);
              if (seenArticles.has(key)) continue;
              seenArticles.add(key);
              articles.push(article);
            }
            if (firstPageOnly) break;
          }
        }
        const result = deduplicatePreviews(articles);
        if (!result.length)
          throw new AppError(
            422,
            "Aucun article trouvé. Vérifiez les sélecteurs CSS.",
            "EMPTY_SCRAPING",
          );
        return { mode: config.mode, articles: result, ...(warnings.length ? { warnings } : {}) };
      } catch (error) {
        if (networkError instanceof AppError) throw networkError;
        if (error instanceof AppError) throw error;
        throw new AppError(
          timedOut ? 504 : 422,
          timedOut
            ? "Délai de scraping dépassé."
            : "Impossible d'extraire les articles. Vérifiez la page et les sélecteurs CSS.",
          timedOut ? "TIMEOUT" : "SCRAPING_ERROR",
        );
      } finally {
        clearTimeout(timer);
        await browser.close();
      }
    });
  }
}
