import { chromium, type Page, type Locator } from "playwright";
import type { JournalLoginConfig } from "@dailybrief/shared";
import { AppError } from "./errors";
import { fetchRemotePage, type FetchPage } from "./network";
import { articleBrowserLimiter } from "./article-browser";
import { MAX_REMOTE_BYTES } from "./remote-response";

export type JournalLogin = { config: JournalLoginConfig; email: string; password: string };

function loginError(code = "JOURNAL_LOGIN_FAILED") {
  const messages: Record<string, string> = {
    JOURNAL_LOGIN_SUCCESS_SELECTOR_INVALID:
      "L'élément de réussite est déjà visible avant connexion. Choisissez un élément propre au compte connecté.",
    JOURNAL_LOGIN_SELECTOR_AMBIGUOUS:
      "Un sélecteur de connexion désigne plusieurs éléments. Précisez-le pour obtenir un seul élément visible.",
    JOURNAL_LOGIN_INSECURE_FORM:
      "Le formulaire doit envoyer le mot de passe par POST et utiliser un champ de type password.",
    JOURNAL_LOGIN_REDIRECT_BLOCKED:
      "La connexion redirige vers une origine non autorisée. Vérifiez l'URL du formulaire et le domaine du journal.",
    JOURNAL_LOGIN_REQUEST_BLOCKED:
      "Le formulaire tente d'envoyer une requête non autorisée. La connexion doit utiliser l'origine HTTPS configurée.",
    JOURNAL_SESSION_EXPIRED:
      "La session du journal a expiré ou l'article renvoie au formulaire de connexion. Vérifiez les identifiants et l'accès de votre compte.",
  };
  return new AppError(
    422,
    messages[code] ??
      "Connexion au journal impossible. Vérifiez le formulaire, les sélecteurs et les identifiants. Une validation à deux étapes ou un CAPTCHA nécessite une intervention sur le site.",
    code,
  );
}

// Cookies exist only in a fresh context for this operation; none are persisted or logged.
export class JournalLoginBrowser {
  constructor(
    private fetchPage: FetchPage = fetchRemotePage,
    private timeoutMs = 15000,
  ) {}
  async run(
    domain: string,
    login: JournalLogin,
    articleUrl?: string,
    observer?: (message: string) => void,
  ): Promise<{ html: string; url: string; contentHtml?: string }> {
    return articleBrowserLimiter.run(async () => {
      const loginOrigin = new URL(login.config.loginUrl).origin;
      const journalOrigin = `https://${domain}`;
      const origins = new Set([loginOrigin, journalOrigin]);
      let target = articleUrl ? new URL(articleUrl) : null;
      if (target) {
        if (
          target.hostname.toLowerCase().replace(/\.$/, "") !== domain ||
          target.username ||
          target.password ||
          !["http:", "https:"].includes(target.protocol) ||
          target.port
        )
          throw new AppError(
            400,
            "Adresse d'article incompatible avec cet accès journal.",
            "JOURNAL_UNSAFE_TARGET",
          );
        target.protocol = "https:";
      }
      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
        });
      } catch {
        throw new AppError(
          503,
          "Chromium est nécessaire pour la connexion aux journaux. Installez-le avec bun run browser:install.",
          "JOURNAL_BROWSER_UNAVAILABLE",
        );
      }
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      const timer = setTimeout(
        () => {
          void context.close().catch(() => {});
        },
        this.timeoutMs * 3 + 10000,
      );
      let authenticating = true;
      let secretsEntered = false;
      let navigations = 0;
      let networkError: AppError | undefined;
      let rejectNetwork = (_error: unknown) => {};
      const networkFailure = new Promise<never>((_resolve, reject) => {
        rejectNetwork = reject;
      });
      void networkFailure.catch(() => {});
      try {
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const navigation = request.isNavigationRequest();
          const method = request.method();
          try {
            if (!["http:", "https:"].includes(url.protocol))
              throw loginError("JOURNAL_UNSAFE_REQUEST");
            if (
              navigation &&
              (!origins.has(url.origin) || url.protocol !== "https:" || ++navigations > 12)
            )
              throw loginError("JOURNAL_LOGIN_REDIRECT_BLOCKED");
            // No credential/session traffic to undeclared origins after inputs are filled.
            if (
              (secretsEntered && !origins.has(url.origin)) ||
              ["image", "media", "font"].includes(request.resourceType())
            ) {
              await route.abort();
              return;
            }
            if (
              !["GET", "POST"].includes(method) ||
              (method === "POST" &&
                (!authenticating || url.origin !== loginOrigin || !secretsEntered))
            ) {
              if (navigation || (authenticating && method === "POST" && secretsEntered))
                throw loginError("JOURNAL_LOGIN_REQUEST_BLOCKED");
              await route.abort();
              return;
            }
            if (
              secretsEntered &&
              [...url.searchParams.values()].some(
                (value) =>
                  value === login.password ||
                  (login.password.length >= 4 && value.includes(login.password)),
              )
            )
              throw loginError("JOURNAL_LOGIN_INSECURE_FORM");
            const body = method === "POST" ? (request.postData() ?? "") : undefined;
            if (body && Buffer.byteLength(body) > 256 * 1024)
              throw loginError("JOURNAL_LOGIN_REQUEST_TOO_LARGE");
            const headers = await request.allHeaders();
            const response = await this.fetchPage(request.url(), {
              method: method as "GET" | "POST",
              body,
              contentType: headers["content-type"],
              requestedWith: headers["x-requested-with"],
              referer: headers.referer,
              cookie: headers.cookie,
              userAgent: headers["user-agent"],
              accept: headers.accept,
              // Every redirect returns to interception before a new request is made.
              followRedirects: false,
            });
            if (response.status >= 400) throw loginError();
            let html = response.text;
            let status = response.status;
            let contentType =
              response.contentType ?? (navigation ? "text/html" : "application/javascript");
            if (response.location) {
              const destination = new URL(response.location, request.url());
              if (
                !origins.has(destination.origin) ||
                destination.protocol !== "https:" ||
                destination.username ||
                destination.password
              )
                throw loginError("JOURNAL_LOGIN_REDIRECT_BLOCKED");
              if (!navigation || (method === "POST" && [307, 308].includes(status)))
                throw loginError("JOURNAL_LOGIN_REDIRECT_UNSUPPORTED");
              html = `<script>window.location.replace(${JSON.stringify(destination.href).replace(/</g, "\\u003c")})</script>`;
              status = 200;
              contentType = "text/html";
            }
            await route.fulfill({
              status,
              body: html,
              headers: {
                "content-type": `${contentType.replace(/;\s*charset\s*=\s*[^;]+/i, "")}; charset=utf-8`,
                ...(response.cookies.length &&
                (!response.url || new URL(response.url).origin === url.origin)
                  ? { "set-cookie": response.cookies.join("\n") }
                  : {}),
              },
            });
          } catch (error) {
            // Transport/Playwright errors can contain passwords, tokens or query parameters.
            // Only fixed messages and codes leave this browser operation.
            if (navigation || (authenticating && method === "POST" && secretsEntered))
              networkError = loginError(
                error instanceof AppError && error.code.startsWith("JOURNAL_")
                  ? error.code
                  : undefined,
              );
            await route.abort().catch(() => {});
            if (networkError) rejectNetwork(networkError);
          }
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        const page = await context.newPage();
        page.setDefaultTimeout(this.timeoutMs);
        return await Promise.race([
          (async () => {
            observer?.("Ouverture du formulaire de connexion du journal.");
            await page.goto(login.config.loginUrl, { waitUntil: "domcontentloaded" });
            const email = await uniqueVisible(page, login.config.emailSelector);
            const password = await uniqueVisible(page, login.config.passwordSelector);
            const submit = await uniqueVisible(page, login.config.submitSelector);
            if (await page.locator(login.config.successSelector).isVisible())
              throw loginError("JOURNAL_LOGIN_SUCCESS_SELECTOR_INVALID");
            if (
              (await password.getAttribute("type")) !== "password" ||
              (await password.evaluate(
                (node) =>
                  node instanceof HTMLInputElement && node.form?.method.toLowerCase() === "get",
              ))
            )
              throw loginError("JOURNAL_LOGIN_INSECURE_FORM");
            secretsEntered = true;
            await email.fill(login.email);
            await password.fill(login.password);
            observer?.("Envoi du formulaire et vérification de la connexion.");
            await submit.click();
            await uniqueVisible(page, login.config.successSelector);
            authenticating = false;
            observer?.("Connexion au journal vérifiée dans cette session.");
            if (!target) return { html: "", url: journalOrigin };
            observer?.("Chargement de l'article avec la session authentifiée.");
            await page.goto(target.href, { waitUntil: "domcontentloaded" });
            await assertArticleAccess(page, login, journalOrigin);
            await page.waitForFunction(() => (document.body?.innerText.trim().length ?? 0) >= 200);
            await page.evaluate(async () => {
              let previous = "";
              let stableSince = performance.now();
              const start = stableSince;
              while (performance.now() - start < 8000) {
                const region =
                  document.querySelector("article, main, [role='main']") ?? document.body;
                const text = region?.textContent?.replace(/\s+/g, " ").trim() ?? "";
                if (text !== previous) {
                  previous = text;
                  stableSince = performance.now();
                }
                const bottom =
                  window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
                if (!bottom) {
                  window.scrollBy(0, Math.max(400, window.innerHeight * 0.8));
                  stableSince = performance.now();
                }
                if (
                  bottom &&
                  performance.now() - start >= 1500 &&
                  performance.now() - stableSince >= 1200
                )
                  return;
                await new Promise((resolve) => setTimeout(resolve, 200));
              }
              throw new Error("Unstable article");
            });
            await assertArticleAccess(page, login, journalOrigin);
            const html = await page.content();
            if (Buffer.byteLength(html) > MAX_REMOTE_BYTES)
              throw loginError("JOURNAL_ARTICLE_TOO_LARGE");
            let contentHtml: string | undefined;
            if (login.config.articleContentSelector) {
              const fullArticle = await uniqueVisible(page, login.config.articleContentSelector);
              contentHtml = `<article>${await fullArticle.innerHTML()}</article>`;
            }
            return { html, url: page.url(), contentHtml };
          })(),
          networkFailure,
        ]);
      } catch (error) {
        if (networkError) throw networkError;
        if (error instanceof AppError && error.code.startsWith("JOURNAL_")) throw error;
        throw loginError();
      } finally {
        clearTimeout(timer);
        await browser.close().catch(() => {});
      }
    });
  }
}

async function uniqueVisible(page: Page, selector: string): Promise<Locator> {
  const locator = page.locator(selector);
  await locator.waitFor({ state: "visible" });
  if ((await locator.count()) !== 1) throw loginError("JOURNAL_LOGIN_SELECTOR_AMBIGUOUS");
  return locator;
}

async function assertArticleAccess(page: Page, login: JournalLogin, journalOrigin: string) {
  if (new URL(page.url()).origin !== journalOrigin) throw loginError("JOURNAL_SESSION_EXPIRED");
  if (
    (await page.locator(login.config.passwordSelector).isVisible()) &&
    (await page.locator(login.config.emailSelector).isVisible())
  )
    throw loginError("JOURNAL_SESSION_EXPIRED");
  const blocking = page.locator(
    ".paywall, #paywall, [data-paywall], #challenge-form, #cf-challenge-running, #captcha",
  );
  for (let i = 0; i < (await blocking.count()); i++)
    if (await blocking.nth(i).isVisible())
      throw new AppError(
        422,
        "L'article reste protégé après connexion. La session ou l'abonnement ne donne pas accès au contenu complet.",
        "JOURNAL_ARTICLE_ACCESS_DENIED",
      );
}
