import { chromium } from "playwright";
import { AppError } from "./errors";
import { ConcurrencyLimiter } from "./concurrency";
import type { FetchPage } from "./network";
import { MAX_REMOTE_BYTES } from "./remote-response";
import {
  BrowserNetwork,
  publicBrowserOptions,
  watchBrowserResponseSize,
  watchBrowserRequests,
  type BrowserNetworkFactory,
} from "./browser-network";
import { UpstreamHttpError } from "./errors";

// Shared across accounts: browser fallback must remain bounded.
export const articleBrowserLimiter = new ConcurrencyLimiter(2);

export class ArticleBrowser {
  constructor(
    private fetchPage?: FetchPage,
    private createNetwork: BrowserNetworkFactory = () => BrowserNetwork.create(),
  ) {}
  async render(
    url: string,
    linkSelector?: string,
    allowedHostname?: string,
  ): Promise<{ html: string; url: string }> {
    return articleBrowserLimiter.run(async () => {
      let browser;
      let network: BrowserNetwork | undefined;
      try {
        if (!this.fetchPage) network = await this.createNetwork();
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
          ...network?.launchOptions,
        });
      } catch {
        await network?.close();
        throw new AppError(
          503,
          "Le site demande JavaScript et des cookies. Le navigateur du backend est indisponible : installez Chromium avec bun run browser:install.",
          "ARTICLE_BROWSER_UNAVAILABLE",
        );
      }
      const context = await browser.newContext(publicBrowserOptions(browser.version()));
      let networkError: unknown;
      let failNavigation = (_error: unknown) => {};
      const navigationFailure = new Promise<never>((_resolve, reject) => {
        failNavigation = reject;
      });
      // A redirect can fail before page.goto attaches its race below.
      void navigationFailure.catch(() => {});
      let navigations = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void context.close();
      }, 45000);
      try {
        if (network) await network.guard(url);
        const page = await context.newPage();
        if (network) {
          const nativeNetwork = network;
          const fail = (error: AppError) => {
            if (networkError instanceof AppError) return;
            networkError = error;
            failNavigation(error);
          };
          await watchBrowserResponseSize(page, fail);
          await watchBrowserRequests(
            page,
            network,
            (request) => {
              if (request.method !== "GET")
                throw new AppError(400, "Cette requête de page n'est pas autorisée.", "UNSAFE_URL");
              if (
                request.mainNavigation &&
                allowedHostname &&
                new URL(request.url).hostname.toLowerCase().replace(/\.$/, "") !== allowedHostname
              )
                throw new AppError(
                  422,
                  "L'article redirige vers un autre journal.",
                  "JOURNAL_REDIRECT_BLOCKED",
                );
            },
            (error, request) => {
              if (request.mainNavigation) fail(error);
            },
          );
          page.on("response", (response) => {
            const request = response.request();
            if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
            if (
              allowedHostname &&
              new URL(response.url()).hostname.toLowerCase().replace(/\.$/, "") !== allowedHostname
            )
              fail(
                new AppError(
                  422,
                  "L'article redirige vers un autre journal.",
                  "JOURNAL_REDIRECT_BLOCKED",
                ),
              );
            if (++navigations > 8)
              fail(new AppError(502, "Trop de redirections navigateur.", "REDIRECT_LIMIT"));
            if (response.status() >= 400)
              fail(new UpstreamHttpError(response.status(), response.url()));
          });
          page.on("requestfailed", (request) => {
            if (
              request.isNavigationRequest() &&
              request.frame() === page.mainFrame() &&
              !networkError
            )
              fail(nativeNetwork.failure(request.url(), request.failure()?.errorText));
          });
        }
        await context.route("**/*", async (route) => {
          const request = route.request();
          if (
            request.method() !== "GET" ||
            ["image", "media", "font"].includes(request.resourceType())
          ) {
            await route.abort().catch(() => {});
            return;
          }
          try {
            if (
              request.isNavigationRequest() &&
              allowedHostname &&
              new URL(request.url()).hostname.toLowerCase().replace(/\.$/, "") !== allowedHostname
            )
              throw new AppError(
                422,
                "L'article redirige vers un autre journal.",
                "JOURNAL_REDIRECT_BLOCKED",
              );
            if (network) {
              await network.guard(request.url());
              await route.continue();
              return;
            }
            if (request.isNavigationRequest() && ++navigations > 8)
              throw new AppError(
                502,
                "La page boucle sur des redirections navigateur.",
                "REDIRECT_LIMIT",
              );
            const headers = await request.allHeaders();
            const response = await this.fetchPage!(request.url(), {
              userAgent: headers["user-agent"],
              cookie: headers.cookie,
              accept: headers.accept,
              // Documents redirect through a fresh browser navigation; subresources
              // follow redirects inside the same DNS-pinned HTTP transport.
              followRedirects: !request.isNavigationRequest(),
              ...(request.isNavigationRequest() && allowedHostname ? { allowedHostname } : {}),
            });
            const contentType =
              response.contentType ??
              (
                {
                  document: "text/html",
                  script: "application/javascript",
                  stylesheet: "text/css",
                } as Record<string, string>
              )[request.resourceType()] ??
              "application/json";
            let body = response.text;
            let status = response.status;
            let renderedType = contentType;
            if (response.location) {
              const target = new URL(response.location, request.url());
              if (
                !["http:", "https:"].includes(target.protocol) ||
                target.username ||
                target.password
              )
                throw new AppError(400, "Cette redirection n'est pas autorisée.", "UNSAFE_URL");
              // Native HTTP redirects may bypass Playwright's route handler. Start a new
              // document navigation instead, so every destination remains DNS-pinned.
              body = `<html><body><script>window.location.replace(${JSON.stringify(target.href).replace(/</g, "\\u003c")});</script></body></html>`;
              status = 200;
              renderedType = "text/html";
            }
            const cookieOriginMatches =
              !response.url || new URL(response.url).origin === new URL(request.url()).origin;
            await route.fulfill({
              status,
              body,
              headers: {
                // The shared transport already decoded the remote charset to UTF-8 text.
                "content-type": `${renderedType.replace(/;\s*charset\s*=\s*[^;]+/i, "")}; charset=utf-8`,
                ...(response.cookies.length && cookieOriginMatches
                  ? { "set-cookie": response.cookies.join("\n") }
                  : {}),
              },
            });
          } catch (error) {
            if (request.isNavigationRequest()) {
              networkError = error;
              failNavigation(error);
            }
            await route.abort().catch(() => {});
          }
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        page.setDefaultTimeout(15000);
        await Promise.race([
          (async () => {
            await page.goto(url, { waitUntil: "networkidle" });
            if (linkSelector) {
              await page.waitForFunction(
                (selector) =>
                  Boolean(document.querySelector(selector)?.getAttribute("href")?.trim()),
                linkSelector,
              );
              return;
            }
            await page.waitForFunction(() => (document.body?.innerText.trim().length ?? 0) >= 200);
            // Network inactivity does not imply that timers, hydration or lazy sections
            // have finished. Scroll through the page and wait for the article text to settle.
            const settled = await page.evaluate(async () => {
              const started = performance.now();
              let changedAt = started;
              let previous = "";
              let scrolls = 0;
              while (performance.now() - started < 8000) {
                const region =
                  document.querySelector("main, [role='main'], article") ?? document.body;
                const text = region?.textContent?.replace(/\s+/g, " ").trim() ?? "";
                if (text !== previous) {
                  previous = text;
                  changedAt = performance.now();
                }
                const atBottom =
                  window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
                if (!atBottom && scrolls < 12) {
                  window.scrollBy(0, Math.max(400, window.innerHeight * 0.8));
                  scrolls++;
                  changedAt = performance.now();
                } else if (
                  performance.now() - started >= 1500 &&
                  performance.now() - changedAt >= 1200
                ) {
                  return true;
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
              }
              // Avoid silently sending an intermediate article snapshot to the AI.
              return performance.now() - changedAt >= 1200;
            });
            if (!settled)
              throw new AppError(
                422,
                "Le texte de l'article continue à changer après le délai de chargement. Réessayez pour éviter un résumé incomplet.",
                "ARTICLE_CONTENT_UNSTABLE",
              );
          })(),
          navigationFailure,
        ]);
        if (networkError instanceof AppError) throw networkError;
        const html = await page.content();
        if (Buffer.byteLength(html, "utf8") > MAX_REMOTE_BYTES)
          throw new AppError(
            413,
            "La page rendue dépasse la limite de 2 Mio.",
            "RESPONSE_TOO_LARGE",
          );
        return { html, url: page.url() };
      } catch (error) {
        if (networkError instanceof AppError) throw networkError;
        if (error instanceof AppError) throw error;
        throw new AppError(
          timedOut ? 504 : 422,
          timedOut
            ? "Le chargement de l'article dans le navigateur a dépassé le délai autorisé."
            : "Le site n'a pas fourni de texte d'article après le chargement JavaScript et des cookies. Il peut refuser l'accès automatisé.",
          timedOut ? "TIMEOUT" : "ARTICLE_BROWSER_BLOCKED",
        );
      } finally {
        clearTimeout(timer);
        await browser.close();
        await network?.close();
      }
    });
  }
}
