import { chromium, errors, type Page, type Request } from "playwright";
import type { ArticlePreview, ScrapingConfig, SourcePreview } from "@dailybrief/shared";
import { scrapingSchema } from "../../shared/src/scraping";
import type { FetchText } from "./network";
import {
  BrowserNetwork,
  publicBrowserOptions,
  watchBrowserResponseSize,
  watchBrowserRequests,
  type BrowserNetworkFactory,
} from "./browser-network";
import { articleUrl } from "./rss";
import { parsePublicationDateGroups } from "./publication-date";
import { AppError, UpstreamHttpError } from "./errors";
import { ConcurrencyLimiter } from "./concurrency";
import { createHash } from "node:crypto";
import { filterRecentArticles, type RecentArticleOptions } from "./recent-articles";

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
async function extract(
  page: Page,
  config: ScrapingConfig,
  timezone = "UTC",
): Promise<ArticlePreview[]> {
  const reference = new Date();
  const entries = await page.evaluate(
    (config) =>
      Array.from(document.querySelectorAll(config.articleSelector)).map((element) => {
        const matches = config.dateSelector
          ? [
              ...(element.matches(config.dateSelector) ? [element] : []),
              ...element.querySelectorAll(config.dateSelector),
            ]
          : [];
        return {
          title: element.querySelector(config.titleSelector)?.textContent?.trim() ?? "",
          url: element.querySelector(config.linkSelector)?.getAttribute("href") ?? null,
          description: config.descriptionSelector
            ? (element.querySelector(config.descriptionSelector)?.textContent?.trim() ?? null)
            : null,
          dateGroups: matches.map((date) => {
            const dates = [
              date,
              ...date.querySelectorAll('time[datetime], [itemprop="datePublished"]'),
            ];
            return [
              ...dates.flatMap((node) =>
                ["datetime", "content", "data-date", "data-published-at"].map((attribute) =>
                  node.getAttribute(attribute),
                ),
              ),
              date.textContent,
              ...(dates.length === 2 ? [dates[1]!.textContent] : []),
            ];
          }),
        };
      }),
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
    .map(({ dateGroups, ...item }) => ({
      ...item,
      url: item.url ? articleUrl(item.url, page.url()) : null,
      publishedAt: parsePublicationDateGroups(dateGroups, timezone, reference),
    }));
}
export class ScrapingService {
  private limiter = new ConcurrencyLimiter(2);
  constructor(
    private fetchText?: FetchText,
    private createNetwork: BrowserNetworkFactory = () => BrowserNetwork.create(),
  ) {}
  async collect(
    url: string,
    input: ScrapingConfig,
    options?: RecentArticleOptions,
  ): Promise<SourcePreview> {
    return this.scrape(url, input, false, options);
  }
  async validateFirstPage(url: string, input: ScrapingConfig): Promise<void> {
    await this.scrape(url, input, true);
  }
  private async scrape(
    url: string,
    input: ScrapingConfig,
    firstPageOnly: boolean,
    options?: RecentArticleOptions,
  ): Promise<SourcePreview> {
    const config = scrapingSchema.parse(input);
    return this.limiter.run(async () => {
      const network = this.fetchText ? undefined : await this.createNetwork();
      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
          ...network?.launchOptions,
        });
      } catch (error) {
        await network?.close();
        throw error;
      }
      const context = await browser.newContext(publicBrowserOptions(browser.version()));
      let timedOut = false;
      let networkError: unknown;
      let failLoad: ((error: unknown) => void) | undefined;
      let pendingLoads = 0;
      let attemptedLoads = 0;
      const blockedPosts = new Set<string>();
      const scriptErrors = new Set<string>();
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
        if (network) {
          const nativeNetwork = network;
          const tracked = new Set<Request>();
          const fail = (error: AppError) => {
            if (networkError instanceof AppError) return;
            networkError = error;
            failLoad?.(error);
          };
          await watchBrowserResponseSize(page, fail, nativeNetwork);
          await watchBrowserRequests(
            page,
            network,
            (request) => {
              const post =
                request.method === "POST" &&
                config.mode === "LOAD_MORE" &&
                ["XHR", "Fetch"].includes(request.resourceType);
              if (request.method !== "GET" && !post)
                throw new AppError(400, "Cette requête de page n'est pas autorisée.", "UNSAFE_URL");
              if (post && new URL(request.url).origin !== new URL(page.url()).origin)
                throw new AppError(
                  400,
                  "Redirection POST vers un autre site interdite.",
                  "UNSAFE_URL",
                );
            },
            (error, request) => {
              if (
                request.method === "POST" &&
                new URL(request.url).origin !== new URL(page.url()).origin
              ) {
                if (failLoad) blockedPosts.add(request.url);
                if (!request.redirected) return;
              }
              if (
                request.mainNavigation ||
                (failLoad && ["XHR", "Fetch"].includes(request.resourceType))
              )
                fail(error);
            },
          );
          page.on("request", (request) => {
            const ajax = ["xhr", "fetch"].includes(request.resourceType());
            const externalPost =
              request.method() === "POST" &&
              new URL(request.url()).origin !== new URL(page.url()).origin;
            if (failLoad && ajax && !externalPost) {
              tracked.add(request);
              pendingLoads++;
              if (new URL(request.url()).origin === new URL(page.url()).origin) attemptedLoads++;
            }
          });
          const finish = (request: Request) => {
            if (tracked.delete(request)) pendingLoads--;
          };
          page.on("requestfinished", finish);
          page.on("requestfailed", (request) => {
            if (
              (request.isNavigationRequest() && request.frame() === page.mainFrame()) ||
              tracked.has(request)
            )
              fail(nativeNetwork.failure(request.url(), request.failure()?.errorText));
            finish(request);
          });
          page.on("response", (response) => {
            const request = response.request();
            if (
              response.status() >= 400 &&
              ((request.isNavigationRequest() && request.frame() === page.mainFrame()) ||
                tracked.has(request))
            )
              fail(new UpstreamHttpError(response.status(), response.url()));
          });
        }
        page.on("pageerror", (error) => {
          if (scriptErrors.size < 3) scriptErrors.add(error.message.slice(0, 300));
        });
        // Production continues Chromium requests through a public-address TCP relay.
        // Explicit fetchers only supply deterministic fixture responses in tests.
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
          if (network) {
            try {
              if (post && new URL(request.url()).origin !== new URL(page.url()).origin) {
                if (failLoad) blockedPosts.add(request.url());
                await route.abort().catch(() => {});
                return;
              }
              await network.guard(request.url());
              await route.continue();
            } catch (error) {
              if (
                (request.isNavigationRequest() && request.frame() === page.mainFrame()) ||
                (failLoad && ajax)
              ) {
                networkError = error;
                failLoad?.(error);
              }
              await route.abort().catch(() => {});
            }
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
            if (tracked && new URL(request.url()).origin === new URL(page.url()).origin)
              attemptedLoads++;
            const headers = request.headers();
            const body = await this.fetchText!(request.url(), {
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
            if (network) {
              await network.guard(target);
              network.beginLoad();
            }
            await page.goto(target, { waitUntil: "networkidle" });
            network?.assertWithinBudget();
          } catch (error) {
            if (networkError instanceof AppError) throw networkError;
            throw error;
          }
          if (networkError instanceof AppError) throw networkError;
        }
        const articles: ArticlePreview[] = [];
        const warnings: string[] = [];
        const readArticles = async () => {
          network?.assertWithinBudget();
          const entries = await extract(page, config, options?.window.timezone);
          network?.assertWithinBudget();
          return entries;
        };
        let ordered = Boolean(options?.newestFirst);
        let previousDate = Infinity;
        const observed = new Set<string>();
        const reachedArchives = (entries: ArticlePreview[]) => {
          if (!ordered || !options) return false;
          let old = false;
          // Repeated DOM entries after a scroll/click must not look like a date inversion.
          // Check the complete loaded batch before applying a cutoff.
          for (const entry of entries) {
            const key = previewKey(entry);
            if (observed.has(key)) continue;
            observed.add(key);
            const timestamp = entry.publishedAt ? new Date(entry.publishedAt).getTime() : NaN;
            if (!Number.isFinite(timestamp) || timestamp > previousDate) {
              ordered = false;
              warnings.push(
                "L'ordre chronologique annoncé ne peut pas être confirmé : le parcours continue sans arrêt anticipé.",
              );
              return false;
            }
            previousDate = timestamp;
            if (timestamp < options.window.start.getTime()) old = true;
          }
          if (old)
            warnings.push(
              "Parcours arrêté aux articles antérieurs à la veille : source déclarée du plus récent au plus ancien.",
            );
          return old;
        };
        if (config.mode === "SCROLL") {
          await navigate(url);
          const initial = await readArticles();
          articles.push(...initial);
          let stop = reachedArchives(initial);
          for (let i = 0; !stop && i < (firstPageOnly ? 0 : config.scroll!.maxScrolls); i++) {
            network?.beginLoad();
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(config.scroll!.waitAfterScrollMs);
            const entries = await readArticles();
            articles.push(...entries);
            stop = reachedArchives(entries);
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
          const initial = deduplicatePreviews(await readArticles());
          articles.push(...initial);
          const seen = new Set(articles.map(previewKey));
          let clicks = 0;
          let stop = reachedArchives(initial);
          while (!firstPageOnly && !stop) {
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
            network?.beginLoad();
            networkError = undefined;
            blockedPosts.clear();
            attemptedLoads = 0;
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
                    const entries = await readArticles();
                    const snapshot = JSON.stringify(entries);
                    if (snapshot !== previous) {
                      previous = snapshot;
                      changedAt = Date.now();
                    }
                    // Some themes ignore clicks while their own loading lock is set,
                    // even after the new DOM is stable and the AJAX response has finished.
                    const busy = await buttons.evaluateAll((elements) =>
                      elements.some((button) =>
                        button.matches(
                          '.fetching, .loading, .is-loading, [aria-busy="true"], [data-loading="true"]',
                        ),
                      ),
                    );
                    if (!pendingLoads && !busy && Date.now() - changedAt >= 300) return entries;
                    await page.waitForTimeout(100);
                  }
                  throw new AppError(
                    504,
                    "Le chargement ne s'est pas terminé ou le bouton reste occupé après le délai autorisé. Augmentez le délai de chargement.",
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
              await readArticles();
              warnings.push(
                `Chargement arrêté après ${clicks} clic(s) : aucun nouvel article dans le délai de ${waitTimeoutMs} ms. Les articles déjà récupérés sont conservés.`,
              );
              if (!attemptedLoads)
                warnings.push(
                  "Aucune requête de chargement AJAX vers le site n'a été observée après le clic. Vérifiez le fonctionnement du bouton et l'initialisation de son script.",
                );
              if (scriptErrors.size)
                warnings.push(
                  `Erreur(s) JavaScript observée(s) : ${Array.from(scriptErrors).join(" ; ")}.`,
                );
              if (blockedPosts.size)
                warnings.push(
                  `Requête(s) POST externe(s) bloquée(s) : ${Array.from(blockedPosts).join(", ")}. Elles peuvent provenir de services annexes ; cela ne permet pas d'identifier la cause de l'absence de nouveaux articles.`,
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
            stop = reachedArchives(entries);
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
            const entries = await readArticles();
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
            if (firstPageOnly || reachedArchives(entries)) break;
          }
        }
        const result = deduplicatePreviews(articles);
        if (!result.length)
          throw new AppError(
            422,
            "Aucun article trouvé. Vérifiez les sélecteurs CSS.",
            "EMPTY_SCRAPING",
          );
        const recent = options ? filterRecentArticles(result, options.window) : null;
        warnings.push(...(recent?.warnings ?? []));
        return {
          mode: config.mode,
          articles: recent?.articles ?? result,
          ...(warnings.length ? { warnings } : {}),
        };
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
        await network?.close();
      }
    });
  }
}
