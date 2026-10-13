import {
  launchScrapingBrowser,
  createScrapingPage,
  interceptRequests,
  delay,
  isVisible,
  navigateScrapingPage,
} from "./browser";
import { TimeoutError } from "puppeteer";
import type { Page, ElementHandle, HTTPRequest } from "puppeteer";
import type { JournalLoginConfig } from "@dailybrief/shared";
import { AppError } from "./errors";
import { fetchRemotePage, RemoteConnectionError, type FetchPage } from "./network";
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
    JOURNAL_LOGIN_PAGE_FAILED:
      "Le navigateur n'a pas pu charger le formulaire de connexion. L'échec intervient avant la saisie des identifiants.",
    JOURNAL_LOGIN_PAGE_TIMEOUT:
      "Le document principal du formulaire n'a pas fini de charger dans le délai prévu. Aucun identifiant n'a été saisi.",
    JOURNAL_LOGIN_PAGE_HTTP_ERROR:
      "Le site a refusé le chargement du formulaire de connexion (erreur HTTP). Aucun identifiant n'a été saisi.",
    JOURNAL_LOGIN_NETWORK_DNS:
      "Le backend ne peut pas résoudre le nom du serveur du journal (DNS).",
    JOURNAL_LOGIN_NETWORK_TLS:
      "Le backend ne peut pas vérifier la connexion HTTPS du journal (certificat ou négociation TLS).",
    JOURNAL_LOGIN_NETWORK_CONNECT:
      "Le backend ne peut pas établir une connexion réseau avec le serveur du journal.",
    JOURNAL_LOGIN_NETWORK_RESET:
      "Le serveur du journal ou un intermédiaire a interrompu la connexion réseau du backend.",
    JOURNAL_LOGIN_NETWORK_UNKNOWN: "Le backend ne peut pas joindre le serveur du journal.",
    JOURNAL_LOGIN_SUBMIT_FAILED:
      "Les champs sont remplis, mais le navigateur n'a pas pu envoyer le formulaire. Vérifiez que le contrôle d'envoi est actif et accessible.",
    JOURNAL_LOGIN_FAILED:
      "La connexion au journal n'a pas pu être confirmée après l'envoi du formulaire. Vérifiez la réponse du journal et vos identifiants.",
    JOURNAL_LOGIN_SUCCESS_SELECTOR_INVALID:
      "L'ancien réglage de vérification est déjà visible avant connexion. Supprimez puis reconfigurez le formulaire de connexion du journal.",
    JOURNAL_LOGIN_UNVERIFIED:
      "La connexion n'a pas pu être confirmée automatiquement. Vérifiez vos identifiants sur le site du journal ; une validation supplémentaire peut être nécessaire.",
    JOURNAL_LOGIN_SELECTOR_AMBIGUOUS:
      "Un sélecteur de connexion désigne plusieurs éléments. Précisez-le pour obtenir un seul élément visible.",
    JOURNAL_LOGIN_FIELDS_UNFILLED:
      "Les champs de connexion n'ont pas conservé les informations saisies. La page peut les réinitialiser ou empêcher la saisie. Aucun formulaire n'a été envoyé.",
    JOURNAL_LOGIN_EMAIL_NOT_FOUND:
      "Le champ email n'a pas été trouvé ou n'est pas visible dans la page de connexion chargée. Vérifiez son sélecteur et l'URL du formulaire.",
    JOURNAL_LOGIN_PASSWORD_NOT_FOUND:
      "Le champ mot de passe n'a pas été trouvé ou n'est pas visible dans la page de connexion chargée. Vérifiez son sélecteur et l'URL du formulaire.",
    JOURNAL_LOGIN_SUBMIT_NOT_FOUND:
      "Les champs sont remplis, mais le contrôle d'envoi n'a pas été trouvé ou n'est pas visible. Vérifiez son sélecteur : certains formulaires utilisent input[type='submit'] au lieu de button[type='submit'].",
    JOURNAL_LOGIN_INSECURE_FORM:
      "Le formulaire doit envoyer le mot de passe par POST et utiliser un champ de type password.",
    JOURNAL_LOGIN_REDIRECT_BLOCKED:
      "La connexion redirige vers une origine non autorisée. Vérifiez l'URL du formulaire et le domaine du journal.",
    JOURNAL_LOGIN_REQUEST_BLOCKED:
      "Le formulaire tente d'envoyer une requête non autorisée. La connexion doit utiliser les origines HTTPS configurées du formulaire et du journal.",
    JOURNAL_ARTICLE_UNAVAILABLE:
      "Le journal n'a pas permis de charger cet article avec la session authentifiée.",
    JOURNAL_SESSION_EXPIRED:
      "La session du journal a expiré ou l'article renvoie au formulaire de connexion. Vérifiez les identifiants et l'accès de votre compte.",
  };
  return new AppError(
    422,
    messages[code] ?? "La connexion au journal a échoué pendant le traitement du formulaire.",
    code,
  );
}

function safeTransportError(error: unknown, fallbackCode: string) {
  if (error instanceof AppError && error.code.startsWith("JOURNAL_")) return loginError(error.code);
  if (error instanceof RemoteConnectionError)
    return loginError(`JOURNAL_LOGIN_NETWORK_${error.reason}`);
  if (error instanceof AppError && error.code === "UNSAFE_URL")
    return loginError("JOURNAL_LOGIN_REQUEST_BLOCKED");
  if (error instanceof AppError && error.code === "UPSTREAM_ERROR")
    return loginError(
      fallbackCode === "JOURNAL_LOGIN_PAGE_FAILED" ? "JOURNAL_LOGIN_PAGE_HTTP_ERROR" : fallbackCode,
    );
  if (
    fallbackCode === "JOURNAL_LOGIN_PAGE_FAILED" &&
    (error instanceof TimeoutError || (error instanceof AppError && error.code === "TIMEOUT"))
  )
    return loginError("JOURNAL_LOGIN_PAGE_TIMEOUT");
  return loginError(fallbackCode);
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
        browser = await launchScrapingBrowser();
      } catch {
        throw new AppError(
          503,
          "Chromium est nécessaire pour la connexion aux journaux. Installez-le avec bun run browser:install.",
          "JOURNAL_BROWSER_UNAVAILABLE",
        );
      }
      const context = await browser.createBrowserContext().catch(async () => {
        await browser.close().catch(() => {});
        throw loginError("JOURNAL_LOGIN_PAGE_FAILED");
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      let callbackStarted = false;
      let authenticating = true;
      let secretsEntered = false;
      let navigations = 0;
      let operationId = 0;
      let loginFailureCode = "JOURNAL_LOGIN_PAGE_FAILED";
      let networkError: AppError | undefined;
      let rejectNetwork = (_error: unknown) => {};
      let networkFailure = new Promise<never>((_resolve, reject) => {
        rejectNetwork = reject;
      });
      void networkFailure.catch(() => {});
      try {
        const handleRequest = async (request: HTTPRequest) => {
          const requestOperationId = operationId;
          const url = new URL(request.url());
          const navigation = request.isNavigationRequest();
          const mainNavigation = navigation && !request.frame()?.parentFrame();
          const method = request.method();
          try {
            if (!["http:", "https:"].includes(url.protocol))
              throw loginError("JOURNAL_UNSAFE_REQUEST");
            // Public pages embed analytics frames. Block them without treating
            // their navigation as a redirect of the actual login document.
            if (navigation && !mainNavigation && !origins.has(url.origin)) {
              await request.abort();
              return;
            }
            if (
              mainNavigation &&
              (!origins.has(url.origin) || url.protocol !== "https:" || ++navigations > 12)
            )
              throw loginError("JOURNAL_LOGIN_REDIRECT_BLOCKED");
            // No credential/session traffic to undeclared origins after inputs are filled.
            if (
              (secretsEntered && !origins.has(url.origin)) ||
              ["image", "media", "font"].includes(request.resourceType())
            ) {
              await request.abort();
              return;
            }
            if (
              !["GET", "POST", "OPTIONS"].includes(method) ||
              (method === "POST" &&
                (!authenticating || !origins.has(url.origin) || !secretsEntered)) ||
              (method === "OPTIONS" && (!authenticating || !origins.has(url.origin)))
            ) {
              if (navigation || (authenticating && method === "POST" && secretsEntered))
                throw loginError("JOURNAL_LOGIN_REQUEST_BLOCKED");
              await request.abort();
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
            const headers = request.headers();
            const response = await this.fetchPage(request.url(), {
              method: method as "GET" | "POST" | "OPTIONS",
              body,
              contentType: headers["content-type"],
              requestedWith: headers["x-requested-with"],
              referer: headers.referer,
              cookie: headers.cookie,
              userAgent: headers["user-agent"],
              accept: headers.accept,
              // Preserve the actual browser origin, including SSO calls from
              // the login host to the declared journal host. Chromium still
              // enforces the server's own CORS response headers below.
              origin: headers.origin && origins.has(headers.origin) ? headers.origin : undefined,
              corsRequestMethod: headers["access-control-request-method"],
              corsRequestHeaders: headers["access-control-request-headers"],
              // Every redirect returns to interception before a new request is made.
              followRedirects: false,
            });
            if (response.status >= 400)
              throw loginError(
                authenticating
                  ? secretsEntered
                    ? "JOURNAL_LOGIN_FAILED"
                    : "JOURNAL_LOGIN_PAGE_HTTP_ERROR"
                  : "JOURNAL_ARTICLE_UNAVAILABLE",
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
            await request.respond({
              status,
              body: html,
              headers: {
                "content-type": `${contentType.replace(/;\s*charset\s*=\s*[^;]+/i, "")}; charset=utf-8`,
                ...response.corsHeaders,
                ...(response.cookies.length &&
                (!response.url || new URL(response.url).origin === url.origin)
                  ? { "set-cookie": response.cookies }
                  : {}),
              },
            });
          } catch (error) {
            // Transport/Puppeteer errors can contain passwords, tokens or query parameters.
            // Only fixed messages and codes leave this browser operation.
            if (requestOperationId !== operationId) {
              await request.abort().catch(() => {});
              return;
            }
            if (mainNavigation || (authenticating && method === "POST" && secretsEntered))
              networkError = safeTransportError(
                error,
                authenticating ? loginFailureCode : "JOURNAL_ARTICLE_UNAVAILABLE",
              );
            await request.abort().catch(() => {});
            if (networkError) rejectNetwork(networkError);
          }
        };
        const page = await createScrapingPage(browser, {}, context);
        await interceptRequests(page, handleRequest);
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
                : safeTransportError(
                    error,
                    authenticating ? loginFailureCode : "JOURNAL_ARTICLE_UNAVAILABLE",
                  ));
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
          // A visible main document can be ready while an iframe is still loading.
          await navigateScrapingPage(page, login.config.loginUrl, { waitForAllResources: false });
          observer?.("Document principal du formulaire chargé.");
          loginFailureCode = "JOURNAL_LOGIN_FIELDS_UNFILLED";
          await assertLoginField(page, login.config.emailSelector, false);
          await assertLoginField(page, login.config.passwordSelector, true);
          const previousSignals = login.config.successSelector
            ? []
            : (await page.evaluate(connectionStateInPage)).signals;
          if (login.config.successSelector && (await isVisible(page, login.config.successSelector)))
            throw loginError("JOURNAL_LOGIN_SUCCESS_SELECTOR_INVALID");
          secretsEntered = true;
          observer?.("Saisie des identifiants dans le formulaire de connexion.");
          await fillLoginForm(page, login);
          observer?.("Champs de connexion remplis et vérifiés.");
          await (
            await uniqueVisible(page, login.config.submitSelector, "JOURNAL_LOGIN_SUBMIT_NOT_FOUND")
          ).dispose();
          observer?.("Envoi du formulaire et vérification de la connexion.");
          loginFailureCode = "JOURNAL_LOGIN_SUBMIT_FAILED";
          await page.locator(login.config.submitSelector).click();
          loginFailureCode = "JOURNAL_LOGIN_FAILED";
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
          const articlePage = await createScrapingPage(browser, {}, context).catch(() => {
            throw loginError("JOURNAL_SESSION_EXPIRED");
          });
          await interceptRequests(articlePage, handleRequest);
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
                  contentHtml = `<article>${await fullArticle.evaluate((node) => node.innerHTML)}</article>`;
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
        throw safeTransportError(error, loginFailureCode);
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
    await delay(100);
  }
  throw loginError("JOURNAL_LOGIN_UNVERIFIED");
}

async function uniqueVisible(
  page: Page,
  selector: string,
  missingCode?: string,
): Promise<ElementHandle<Element>> {
  const element = await page.waitForSelector(selector, { visible: true }).catch((error) => {
    if (missingCode) throw loginError(missingCode);
    throw error;
  });
  if (!element || (await page.$$eval(selector, (elements) => elements.length)) !== 1) {
    await element?.dispose();
    throw loginError("JOURNAL_LOGIN_SELECTOR_AMBIGUOUS");
  }
  return element;
}

async function assertLoginField(page: Page, selector: string, password: boolean) {
  const field = await uniqueVisible(
    page,
    selector,
    password ? "JOURNAL_LOGIN_PASSWORD_NOT_FOUND" : "JOURNAL_LOGIN_EMAIL_NOT_FOUND",
  );
  try {
    const valid = await field.evaluate(
      (node, password) =>
        node instanceof HTMLInputElement &&
        (password
          ? node.type === "password" && node.form?.method.toLowerCase() !== "get"
          : ["email", "text"].includes(node.type)),
      password,
    );
    if (!valid)
      throw loginError(password ? "JOURNAL_LOGIN_INSECURE_FORM" : "JOURNAL_LOGIN_FIELDS_UNFILLED");
  } finally {
    await field.dispose();
  }
}

async function fillLoginForm(page: Page, login: JournalLogin) {
  // Selectors must be resolved again: hydration or validation can replace the
  // inputs and submit button while typing. Never reuse their original handles.
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const [selector, value, password] of [
      [login.config.emailSelector, login.email, false],
      [login.config.passwordSelector, login.password, true],
    ] as const) {
      await assertLoginField(page, selector, password);
      try {
        await page
          .locator(selector)
          .filter((node) => node instanceof HTMLInputElement && !node.readOnly)
          .fill(value);
        // Commit native change/blur handlers before inspecting the current DOM.
        await page.keyboard.press("Tab");
      } catch {
        throw loginError("JOURNAL_LOGIN_FIELDS_UNFILLED");
      }
    }
    await delay(100);
    await assertLoginField(page, login.config.passwordSelector, true);
    const filled = await page.evaluate(({ config, email, password }) => {
      const matches = (selector: string, value: string) => {
        const fields = document.querySelectorAll(selector);
        return (
          fields.length === 1 && fields[0] instanceof HTMLInputElement && fields[0].value === value
        );
      };
      return matches(config.emailSelector, email) && matches(config.passwordSelector, password);
    }, login);
    if (filled) return;
  }
  throw loginError("JOURNAL_LOGIN_FIELDS_UNFILLED");
}

async function assertArticleAccess(page: Page, login: JournalLogin, journalOrigin: string) {
  if (new URL(page.url()).origin !== journalOrigin) throw loginError("JOURNAL_SESSION_EXPIRED");
  if (
    (await isVisible(page, login.config.passwordSelector)) &&
    (await isVisible(page, login.config.emailSelector))
  )
    throw loginError("JOURNAL_SESSION_EXPIRED");
  if (
    await isVisible(
      page,
      ".paywall, #paywall, [data-paywall], #challenge-form, #cf-challenge-running, #captcha",
    )
  )
    throw new AppError(
      422,
      "L'article reste protégé après connexion. La session ou l'abonnement ne donne pas accès au contenu complet.",
      "JOURNAL_ARTICLE_ACCESS_DENIED",
    );
}
