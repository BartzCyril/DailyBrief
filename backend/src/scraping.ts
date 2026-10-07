import { chromium, errors, type Page } from "playwright";
import type { ArticlePreview, ScrapingConfig, SourcePreview } from "@dailybrief/shared";
import { scrapingSchema } from "../../shared/src/scraping";
import { fetchRemoteText, type FetchText } from "./network";
import { articleDate, articleUrl } from "./rss";
import { AppError, UpstreamHttpError } from "./errors";
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
function samePage(first: string, second: string): boolean {
  const normalize = (value: string) => {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.searchParams.sort();
    return url.href;
  };
  return normalize(first) === normalize(second);
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
      let failLoad: ((error: unknown) => void) | undefined;
      let pendingLoads = 0;
      let completedLoads = 0;
      const blockedPosts = new Set<string>();
      const timer =
        config.mode === "SCROLL"
          ? setTimeout(() => {
              timedOut = true;
              void context.close();
            }, 45000)
          : undefined;
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        // Fulfil every network request through the same DNS-pinned SSRF guard as RSS.
        await context.route("**/*", async (route) => {
          const request = route.request();
          const ajax = ["xhr", "fetch"].includes(request.resourceType());
          const post = request.method() === "POST" && config.mode === "LOAD_MORE" && ajax;
          if (
            (request.method() !== "GET" && !post) ||
            ["image", "media", "font"].includes(request.resourceType())
          ) {
            await route.abort();
            return;
          }
          const tracked = Boolean(failLoad && ajax);
          if (tracked) pendingLoads++;
          try {
            if (post && new URL(request.url()).origin !== new URL(page.url()).origin) {
              // A click can also trigger analytics or other unrelated POSTs. Abort
              // them without failing an article batch that loads successfully.
              if (tracked) blockedPosts.add(request.url());
              await route.abort().catch(() => {});
              return;
            }
            const headers = request.headers();
            const body = await this.fetchText(request.url(), {
              method: post ? "POST" : "GET",
              ...(post
                ? { body: request.postData() ?? undefined, contentType: headers["content-type"] }
                : {}),
              accept: headers.accept,
              requestedWith: headers["x-requested-with"],
              cookie: headers.cookie,
            });
            const contentType =
              (
                {
                  document: "text/html",
                  script: "application/javascript",
                  stylesheet: "text/css",
                } as Record<string, string>
              )[request.resourceType()] ?? "application/json";
            await route.fulfill({ body, contentType: `${contentType}; charset=utf-8` });
            if (tracked && new URL(request.url()).origin === new URL(page.url()).origin)
              completedLoads++;
          } catch (error) {
            if (
              (request.isNavigationRequest() && request.frame() === page.mainFrame()) ||
              (failLoad && ajax)
            ) {
              networkError = error;
              failLoad?.(error);
            }
            await route.abort().catch(() => {});
          } finally {
            if (tracked) pendingLoads--;
          }
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        async function navigate(target: string) {
          networkError = undefined;
          try {
            await page.goto(target, { waitUntil: "networkidle" });
          } catch (error) {
            if (networkError instanceof AppError) throw networkError;
            throw error;
          }
          if (networkError instanceof AppError) throw networkError;
        }
        const articles: ArticlePreview[] = [];
        const warnings: string[] = [];
        if (config.mode === "SCROLL") {
          await navigate(url);
          articles.push(...(await extract(page, config)));
          for (let i = 0; i < (firstPageOnly ? 0 : config.scroll!.maxScrolls); i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(config.scroll!.waitAfterScrollMs);
            articles.push(...(await extract(page, config)));
          }
        } else if (config.mode === "LOAD_MORE") {
          await navigate(url);
          const { buttonSelector, waitTimeoutMs } = config.loadMore!;
          try {
            await page.evaluate(
              (selector) => document.querySelectorAll(selector).length,
              buttonSelector,
            );
          } catch {
            throw new AppError(
              422,
              "Sélecteur du bouton invalide. Vérifiez le sélecteur CSS.",
              "INVALID_LOAD_MORE_BUTTON",
            );
          }
          articles.push(...deduplicatePreviews(await extract(page, config)));
          const seen = new Set(articles.map(previewKey));
          let clicks = 0;
          while (!firstPageOnly) {
            const buttons = page.locator(buttonSelector).filter({ visible: true });
            const count = await buttons.count();
            if (!count) {
              if (!clicks)
                warnings.push(
                  "Aucun bouton visible trouvé : seuls les articles de la page initiale ont été récupérés. Vérifiez le sélecteur du bouton si des articles manquent.",
                );
              break;
            }
            if (count > 1)
              throw new AppError(
                422,
                "Plusieurs boutons correspondent au sélecteur. Précisez le sélecteur du bouton à cliquer.",
                "INVALID_LOAD_MORE_BUTTON",
              );
            if (!(await buttons.isEnabled())) break;
            networkError = undefined;
            blockedPosts.clear();
            completedLoads = 0;
            const failure = new Promise<never>((_resolve, reject) => {
              failLoad = reject;
            });
            let entries: ArticlePreview[] | undefined;
            try {
              entries = await Promise.race([
                (async () => {
                  await buttons.click({ timeout: waitTimeoutMs });
                  clicks++;
                  const deadline = Date.now() + waitTimeoutMs;
                  try {
                    await page.waitForFunction(
                      ({ config, known }) => {
                        const seen = new Set(known);
                        return Array.from(document.querySelectorAll(config.articleSelector)).some(
                          (element) => {
                            const title = element
                              .querySelector(config.titleSelector)
                              ?.textContent?.trim();
                            if (!title) return false;
                            const href = element
                              .querySelector(config.linkSelector)
                              ?.getAttribute("href");
                            const description = config.descriptionSelector
                              ? (element
                                  .querySelector(config.descriptionSelector)
                                  ?.textContent?.trim() ?? null)
                              : null;
                            let url: string | null = null;
                            if (href) {
                              try {
                                const parsed = new URL(href, document.baseURI);
                                if (
                                  ["http:", "https:"].includes(parsed.protocol) &&
                                  !parsed.username &&
                                  !parsed.password
                                )
                                  url = parsed.href;
                              } catch {
                                /* Fall back to the same title/description key as extraction. */
                              }
                            }
                            const key = url ?? `${title}:${description}`;
                            return !seen.has(key);
                          },
                        );
                      },
                      { config, known: Array.from(seen) },
                      { timeout: waitTimeoutMs, polling: 100 },
                    );
                  } catch (error) {
                    if (!(error instanceof errors.TimeoutError)) throw error;
                    return undefined;
                  }
                  // Networkidle can already have fired for the initial document. Wait for
                  // this click's AJAX requests and a stable list, including staged rendering.
                  let previous = "";
                  let changedAt = Date.now();
                  while (Date.now() < deadline) {
                    const entries = await extract(page, config);
                    const snapshot = JSON.stringify(entries);
                    if (snapshot !== previous) {
                      previous = snapshot;
                      changedAt = Date.now();
                    }
                    if (!pendingLoads && Date.now() - changedAt >= 300) return entries;
                    await page.waitForTimeout(100);
                  }
                  throw new AppError(
                    504,
                    "Les articles ne se sont pas stabilisés dans le délai après le clic. Augmentez le délai de chargement.",
                    "LOAD_MORE_TIMEOUT",
                  );
                })(),
                failure,
              ]);
            } finally {
              failLoad = undefined;
            }
            if (!entries) {
              // Check extraction again so an invalid selector cannot pass as an exhausted button.
              await extract(page, config);
              if (blockedPosts.size && !completedLoads)
                throw new AppError(
                  400,
                  `Aucun nouvel article après le clic. Requête(s) POST vers un autre site bloquée(s) : ${Array.from(blockedPosts).join(", ")}. Vérifiez l'adresse de chargement utilisée par le bouton.`,
                  "UNSAFE_URL",
                );
              warnings.push(
                `Chargement arrêté après ${clicks} clic(s) : aucun nouvel article dans le délai de ${waitTimeoutMs} ms. Les articles déjà récupérés sont conservés.`,
              );
              break;
            }
            let added = 0;
            for (const article of entries) {
              const key = previewKey(article);
              if (seen.has(key)) continue;
              seen.add(key);
              articles.push(article);
              added++;
            }
            if (!added) {
              warnings.push(
                `Chargement arrêté après ${clicks} clic(s) : les articles affichés ont déjà été récupérés.`,
              );
              break;
            }
          }
        } else {
          const seenPages = new Set<string>();
          const seenArticles = new Set<string>();
          for (let number = config.pagination!.startPage; ; number++) {
            const target = paginationUrl(url, config, number);
            try {
              await navigate(target);
            } catch (error) {
              if (
                articles.length &&
                error instanceof UpstreamHttpError &&
                [404, 410].includes(error.upstreamStatus) &&
                samePage(target, error.url)
              ) {
                warnings.push(
                  `Fin de pagination à la page ${number} : ${target} renvoie HTTP ${error.upstreamStatus}. Les articles des pages précédentes sont conservés.`,
                );
                networkError = undefined;
                break;
              }
              throw error;
            }
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
