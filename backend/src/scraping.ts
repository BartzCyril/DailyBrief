import { chromium, type Page } from "playwright";
import type { ArticlePreview, ScrapingConfig, SourcePreview } from "@dailybrief/shared";
import { scrapingSchema } from "../../shared/src/scraping";
import { fetchRemoteText, type FetchText } from "./network";
import { articleDate, articleUrl } from "./rss";
import { AppError } from "./errors";
import { ConcurrencyLimiter } from "./concurrency";

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
    const key = item.url ?? `${item.title}:${item.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function extract(page: Page, config: ScrapingConfig): Promise<ArticlePreview[]> {
  const entries = await page.evaluate(
    (config) =>
      Array.from(document.querySelectorAll(config.articleSelector))
        .slice(0, 200)
        .map((element) => ({
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
    const config = scrapingSchema.parse(input);
    return this.limiter.run(async () => {
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
      });
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      let timedOut = false;
      let networkError: unknown;
      const timer = setTimeout(() => {
        timedOut = true;
        void context.close();
      }, 45000);
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
        if (config.mode === "SCROLL") {
          await page.goto(url, { waitUntil: "networkidle" });
          articles.push(...(await extract(page, config)));
          for (let i = 0; i < config.scroll!.maxScrolls; i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(config.scroll!.waitAfterScrollMs);
            articles.push(...(await extract(page, config)));
          }
        } else {
          for (let i = 0; i < config.pagination!.maxPages; i++) {
            await page.goto(paginationUrl(url, config, config.pagination!.startPage + i), {
              waitUntil: "networkidle",
            });
            const entries = await extract(page, config);
            if (!entries.length) break;
            articles.push(...entries);
          }
        }
        const result = deduplicatePreviews(articles).slice(0, 500);
        if (!result.length)
          throw new AppError(
            422,
            "Aucun article trouvé. Vérifiez les sélecteurs CSS.",
            "EMPTY_SCRAPING",
          );
        return { mode: config.mode, articles: result };
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
