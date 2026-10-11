import { chromium, type Page, type Locator } from "playwright";
import type { JournalLoginConfig } from "@dailybrief/shared";
import { AppError } from "./errors";
import { fetchRemotePage, type FetchPage } from "./network";
import { articleBrowserLimiter } from "./article-browser";
import { MAX_REMOTE_BYTES } from "./remote-response";

export type JournalLogin = { config: JournalLoginConfig; email: string; password: string };
export type JournalPage = { html: string; url: string; contentHtml?: string };
export type JournalPageReader = (
  url: string,
  observer?: (message: string) => void,
) => Promise<JournalPage>;

function articleTarget(domain: string, url: string) {
  const target = new URL(url);
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
  return target;
}

function loginError(code = "JOURNAL_LOGIN_FAILED") {
  const messages: Record<string, string> = {
    JOURNAL_LOGIN_SUCCESS_SELECTOR_INVALID:
      "L'ancien réglage de vérification est déjà visible avant connexion. Supprimez puis reconfigurez le formulaire de connexion du journal.",
    JOURNAL_LOGIN_UNVERIFIED:
      "La connexion n'a pas pu être confirmée automatiquement. Vérifiez vos identifiants sur le site du journal ; une validation supplémentaire peut être nécessaire.",
    JOURNAL_LOGIN_SELECTOR_AMBIGUOUS:
      "Un sélecteur de connexion désigne plusieurs éléments. Précisez-le pour obtenir un seul élément visible.",
    JOURNAL_LOGIN_INSECURE_FORM:
      "Le formulaire doit envoyer le mot de passe par POST et utiliser un champ de type password.",
    JOURNAL_LOGIN_REDIRECT_BLOCKED:
      "La connexion redirige vers une origine non autorisée. Vérifiez l'URL du formulaire et le domaine du journal.",
    JOURNAL_LOGIN_REQUEST_BLOCKED:
      "Le formulaire tente d'envoyer une requête non autorisée. La connexion doit utiliser l'origine HTTPS configurée.",
    JOURNAL_ARTICLE_UNAVAILABLE:
      "Le journal n'a pas permis de charger cet article avec la session authentifiée.",
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

// One ephemeral context per batch: cookies are never persisted or shared with another user/run.
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
  ): Promise<JournalPage> {
    if (articleUrl) articleTarget(domain, articleUrl);
    return this.withSession(
      domain,
      login,
      async (read) =>
        articleUrl ? read(articleUrl, observer) : { html: "", url: `https://${domain}` },
      observer,
    );
  }
  async withSession<T>(
    domain: string,
    login: JournalLogin,
    use: (read: JournalPageReader) => Promise<T>,
    observer?: (message: string) => void,
  ): Promise<T> {
    return articleBrowserLimiter.run(async () => {
      const loginOrigin = new URL(login.config.loginUrl).origin;
      const journalOrigin = `https://${domain}`;
      const origins = new Set([loginOrigin, journalOrigin]);
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
      const context = await browser
        .newContext({ serviceWorkers: "block", acceptDownloads: false })
        .catch(async () => {
          await browser.close().catch(() => {});
          throw loginError();
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      let callbackStarted = false;
      let authenticating = true;
      let secretsEntered = false;
      let navigations = 0;
      let operationId = 0;
      let networkError: AppError | undefined;
      let rejectNetwork = (_error: unknown) => {};
      let networkFailure = new Promise<never>((_resolve, reject) => {
        rejectNetwork = reject;
      });
      void networkFailure.catch(() => {});
      try {
        await context.route("**/*", async (route) => {
          const requestOperationId = operationId;
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
            if (response.status >= 400)
              throw loginError(
                authenticating ? "JOURNAL_LOGIN_FAILED" : "JOURNAL_ARTICLE_UNAVAILABLE",
              );
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
            if (requestOperationId !== operationId) {
              await route.abort().catch(() => {});
              return;
            }
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
        const execute = async <R>(
          action: () => Promise<R>,
          abort: () => Promise<void> = () => context.close().catch(() => {}),
        ): Promise<R> => {
          operationId++;
          navigations = 0;
          networkError = undefined;
          networkFailure = new Promise<never>((_resolve, reject) => {
            rejectNetwork = reject;
          });
          void networkFailure.catch(() => {});
          timer = setTimeout(
            () => {
              void context.close().catch(() => {});
            },
            this.timeoutMs * 3 + 10000,
          );
          const operation = action();
          try {
            return await Promise.race([operation, networkFailure]);
          } catch (error) {
            const safeError =
              networkError ??
              (error instanceof AppError && error.code.startsWith("JOURNAL_")
                ? error
                : loginError());
            await abort();
            throw safeError;
          } finally {
            // A rejected interception can win the race while goto is still
            // unwinding. Finish it before the next article uses the same page.
            await operation.catch(() => {});
            clearTimeout(timer);
          }
        };
        await execute(async () => {
          observer?.("Ouverture du formulaire de connexion du journal.");
          await page.goto(login.config.loginUrl, { waitUntil: "domcontentloaded" });
          const email = await uniqueVisible(page, login.config.emailSelector);
          const password = await uniqueVisible(page, login.config.passwordSelector);
          const submit = await uniqueVisible(page, login.config.submitSelector);
          const previousSignals = login.config.successSelector
            ? []
            : (await page.evaluate(connectionStateInPage)).signals;
          if (
            login.config.successSelector &&
            (await page.locator(login.config.successSelector).isVisible())
          )
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
          if (login.config.successSelector) await uniqueVisible(page, login.config.successSelector);
          else await confirmConnection(page, previousSignals, this.timeoutMs);
          authenticating = false;
          observer?.("Connexion au journal vérifiée dans cette session.");
        });
        const readPage: JournalPageReader = async (url, notify) => {
          const target = articleTarget(domain, url);
          if (expired || page.isClosed()) throw loginError("JOURNAL_SESSION_EXPIRED");
          // Keep the authenticated context and cookies, but isolate failed
          // navigations in a temporary tab so Chromium's error page cannot
          // interrupt the following article.
          const articlePage = await context.newPage().catch(() => {
            throw loginError("JOURNAL_SESSION_EXPIRED");
          });
          articlePage.setDefaultTimeout(this.timeoutMs);
          try {
            return await execute(
              async () => {
                const page = articlePage;
                const observer = notify;

                observer?.("Chargement de l'article avec la session authentifiée.");
                await page.goto(target.href, { waitUntil: "domcontentloaded" });
                await assertArticleAccess(page, login, journalOrigin);
                await page.waitForFunction(
                  () => (document.body?.innerText.trim().length ?? 0) >= 200,
                );
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
                      window.scrollY + window.innerHeight >=
                      document.documentElement.scrollHeight - 2;
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
                  const fullArticle = await uniqueVisible(
                    page,
                    login.config.articleContentSelector,
                  );
                  contentHtml = `<article>${await fullArticle.innerHTML()}</article>`;
                }
                return { html, url: page.url(), contentHtml };
              },
              () => articlePage.close().catch(() => {}),
            );
          } catch (error) {
            if (error instanceof AppError && error.code === "JOURNAL_SESSION_EXPIRED")
              expired = true;
            throw error;
          } finally {
            await articlePage.close().catch(() => {});
          }
        };
        let reads = Promise.resolve();
        const read: JournalPageReader = (url, notify) => {
          const pending = reads.then(() => readPage(url, notify));
          reads = pending.then(
            () => {},
            () => {},
          );
          return pending;
        };
        callbackStarted = true;
        try {
          return await use(read);
        } finally {
          await reads;
        }
      } catch (error) {
        if (callbackStarted) throw error;
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

// A redirect, cookie, or disappearance of the form alone never confirms authentication.
function connectionStateInPage() {
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility === "visible" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const normalize = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const signals = [...document.querySelectorAll("a, button, [role='button'], [role='menuitem']")]
    .filter(visible)
    .flatMap((element) => {
      const label = normalize(
        element.textContent?.trim() || element.getAttribute("aria-label") || "",
      );
      let href = "";
      if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) {
        try {
          href = new URL(element.href, location.href).pathname;
        } catch {
          // An unrelated malformed link must not prevent verification of a valid account control.
        }
      }
      if (
        /^(deconnexion|se deconnecter|log out|logout|sign out)$/.test(label) ||
        /(?:^|\/)(?:logout|log-out|signout|sign-out|deconnexion)(?:\/|\.|$)/i.test(href)
      )
        return ["logout"];
      return [];
    });
  return {
    signals,
    passwordVisible: [...document.querySelectorAll("input[type='password']")].some(visible),
  };
}

async function confirmConnection(page: Page, previousSignals: string[], timeoutMs: number) {
  const before = new Set(previousSignals);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(connectionStateInPage);
      if (!state.passwordVisible && state.signals.some((signal) => !before.has(signal))) return;
    } catch {
      // A form submission can replace the document during this check.
      if (page.isClosed()) throw loginError();
    }
    await page.waitForTimeout(100);
  }
  throw loginError("JOURNAL_LOGIN_UNVERIFIED");
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
