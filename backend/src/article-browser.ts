import { chromium } from "playwright";
import { AppError } from "./errors";
import { ConcurrencyLimiter } from "./concurrency";
import { fetchRemotePage, type FetchPage } from "./network";
import { MAX_REMOTE_BYTES } from "./remote-response";

// Shared across accounts: browser fallback must remain bounded.
const limiter = new ConcurrencyLimiter(2);

export class ArticleBrowser {
  constructor(private fetchPage: FetchPage = fetchRemotePage) {}
  async render(url: string): Promise<{ html: string; url: string }> {
    return limiter.run(async () => {
      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
        });
      } catch {
        throw new AppError(
          503,
          "Le site demande JavaScript et des cookies. Le navigateur du backend est indisponible : installez Chromium avec bun run browser:install.",
          "ARTICLE_BROWSER_UNAVAILABLE",
        );
      }
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
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
            if (request.isNavigationRequest() && ++navigations > 8)
              throw new AppError(
                502,
                "La page boucle sur des redirections navigateur.",
                "REDIRECT_LIMIT",
              );
            const headers = await request.allHeaders();
            const response = await this.fetchPage(request.url(), {
              userAgent: headers["user-agent"],
              cookie: headers.cookie,
              accept: headers.accept,
              // Documents redirect through a fresh browser navigation; subresources
              // follow redirects inside the same DNS-pinned HTTP transport.
              followRedirects: !request.isNavigationRequest(),
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
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        await Promise.race([
          (async () => {
            await page.goto(url, { waitUntil: "networkidle" });
            await page.waitForFunction(() => (document.body?.innerText.trim().length ?? 0) >= 200);
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
      }
    });
  }
}
