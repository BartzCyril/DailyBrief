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
import { AppError, UpstreamHttpError } from "./errors";
import {
  fetchRemotePage,
  RemoteConnectionError,
  browserApplicationHeaders,
  validateRemoteUrl,
  type FetchPage,
} from "./network";
import { articleBrowserLimiter } from "./article-browser";
import { MAX_REMOTE_BYTES } from "./remote-response";
import { visibleJournalSelector } from "./journal-login-selectors";
import {
  BrowserNetwork,
  publicBrowserOptions,
  watchBrowserResponseSize,
  type BrowserNetworkFactory,
} from "./browser-network";
import { prepareJournalNativePage, blockJournalAuxiliaryTargets } from "./journal-native-guard";
import { JournalHttpError, journalHttpError } from "./journal-http-error";

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
    JOURNAL_LOGIN_REDIRECT_LIMIT: "La connexion au journal boucle sur trop de redirections.",
    JOURNAL_LOGIN_REQUEST_BLOCKED:
      "Le formulaire tente d'envoyer une requête non autorisée. La connexion doit utiliser les origines HTTPS configurées du formulaire et du journal.",
    JOURNAL_ARTICLE_UNAVAILABLE:
      "Le journal n'a pas permis de charger cet article avec la session authentifiée.",
    JOURNAL_ARTICLE_HTTP_ERROR:
      "Le journal a retourné une erreur HTTP lors du chargement de l'article avec la session authentifiée.",
    JOURNAL_ARTICLE_PAGE_FAILED:
      "Le navigateur n'a pas pu ouvrir la page de l'article avec la session authentifiée.",
    JOURNAL_ARTICLE_PAGE_TIMEOUT:
      "Le document principal de l'article n'a pas fini de charger dans le délai prévu avec la session authentifiée.",
    JOURNAL_ARTICLE_CONTENT_FAILED:
      "La page de l'article est chargée, mais son contenu n'a pas pu être extrait avec la session authentifiée.",
    JOURNAL_ARTICLE_CONTENT_TIMEOUT:
      "La page de l'article est chargée, mais le contenu attendu n'est pas apparu dans le délai prévu.",
    JOURNAL_ARTICLE_TOO_LARGE: "La page de l'article dépasse la taille de contenu autorisée.",
    JOURNAL_ARTICLE_NETWORK_DNS:
      "Le backend ne peut pas résoudre le nom du serveur de l'article (DNS).",
    JOURNAL_ARTICLE_NETWORK_TLS:
      "Le backend ne peut pas vérifier la connexion HTTPS de l'article (certificat ou négociation TLS).",
    JOURNAL_ARTICLE_NETWORK_CONNECT:
      "Le backend ne peut pas établir une connexion réseau avec le serveur de l'article.",
    JOURNAL_ARTICLE_NETWORK_RESET:
      "Le serveur de l'article ou un intermédiaire a interrompu la connexion réseau du backend.",
    JOURNAL_ARTICLE_NETWORK_UNKNOWN: "Le backend ne peut pas joindre le serveur de l'article.",
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
  if (error instanceof JournalHttpError) return error;
  if (error instanceof AppError && error.code.startsWith("JOURNAL_")) return loginError(error.code);
  const article = fallbackCode.startsWith("JOURNAL_ARTICLE_");
  if (article && error instanceof AppError && error.code === "UPSTREAM_ERROR") {
    const status = error instanceof UpstreamHttpError ? error.upstreamStatus : undefined;
    return status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599
      ? journalHttpError(status)
      : loginError("JOURNAL_ARTICLE_HTTP_ERROR");
  }
  if (error instanceof RemoteConnectionError)
    return loginError(`JOURNAL_${article ? "ARTICLE" : "LOGIN"}_NETWORK_${error.reason}`);
  if (article && error instanceof AppError && error.code === "RESPONSE_TOO_LARGE")
    return loginError("JOURNAL_ARTICLE_TOO_LARGE");
  if (
    article &&
    (error instanceof TimeoutError || (error instanceof AppError && error.code === "TIMEOUT"))
  )
    return loginError(
      fallbackCode === "JOURNAL_ARTICLE_CONTENT_FAILED"
        ? "JOURNAL_ARTICLE_CONTENT_TIMEOUT"
        : "JOURNAL_ARTICLE_PAGE_TIMEOUT",
    );
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

function hasPasswordInUrl(url: URL, password: string) {
  return [...url.searchParams.values()].some(
    (value) => value === password || (password.length >= 4 && value.includes(password)),
  );
}

// One ephemeral context per batch: cookies are never persisted or shared with another user/run.
export class JournalLoginBrowser {
  constructor(
    private fetchPage?: FetchPage,
    private timeoutMs = 15000,
    private createNetwork?: BrowserNetworkFactory,
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
      let network: BrowserNetwork | undefined;
      let closeTargetGuard: (() => Promise<void>) | undefined;
      try {
        if (!this.fetchPage) {
          const destinations = new Set(
            [...origins].map((origin) => {
              const target = new URL(origin);
              return `${target.hostname}:${target.port || "443"}`;
            }),
          );
          network = await (this.createNetwork?.() ??
            BrowserNetwork.create(async (value) => {
              const target = new URL(value);
              const destination = `${target.hostname}:${target.port || (target.protocol === "https:" ? "443" : "80")}`;
              // Restrict the relay itself, including channels that don't belong
              // to the controlled page. Third-party public assets before login
              // use the existing guarded text transport below.
              if (!destinations.has(destination)) throw loginError("JOURNAL_LOGIN_REQUEST_BLOCKED");
              return validateRemoteUrl(value);
            }));
        }
        browser = await launchScrapingBrowser(network?.launchOptions);
      } catch {
        await network?.close().catch(() => {});
        throw new AppError(
          503,
          "Chromium est nécessaire pour la connexion aux journaux. Installez-le avec bun run browser:install.",
          "JOURNAL_BROWSER_UNAVAILABLE",
        );
      }
      const context = await browser.createBrowserContext().catch(async () => {
        await browser.close().catch(() => {});
        await network?.close().catch(() => {});
        throw loginError("JOURNAL_LOGIN_PAGE_FAILED");
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      let callbackStarted = false;
      let authenticating = true;
      let secretsEntered = false;
      let submissionStarted = false;
      let submittedMainNavigation = false;
      let submissionError: AppError | undefined;
      let navigations = 0;
      let operationId = 0;
      let loginFailureCode = "JOURNAL_LOGIN_PAGE_FAILED";
      let articleFailureCode = "JOURNAL_ARTICLE_PAGE_FAILED";
      let networkError: AppError | undefined;
      let rejectNetwork = (_error: unknown) => {};
      let networkFailure = new Promise<never>((_resolve, reject) => {
        rejectNetwork = reject;
      });
      void networkFailure.catch(() => {});
      const requestOperations = new WeakMap<HTTPRequest, number>();
      const nativeRequests = new WeakSet<HTTPRequest>();
      try {
        const handleRequest = async (request: HTTPRequest) => {
          const requestOperationId = operationId;
          requestOperations.set(request, requestOperationId);
          const url = new URL(request.url());
          const navigation = request.isNavigationRequest();
          const mainNavigation = navigation && !request.frame()?.parentFrame();
          const method = request.method();
          try {
            if (!["http:", "https:"].includes(url.protocol))
              throw loginError("JOURNAL_UNSAFE_REQUEST");
            if (request.redirectChain().length >= 12)
              throw loginError("JOURNAL_LOGIN_REDIRECT_LIMIT");
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
              (method === "OPTIONS" &&
                (!origins.has(url.origin) ||
                  (!authenticating &&
                    request.headers()["access-control-request-method"] !== "GET")))
            ) {
              if (navigation || (authenticating && method === "POST" && secretsEntered))
                throw loginError("JOURNAL_LOGIN_REQUEST_BLOCKED");
              await request.abort();
              return;
            }
            if (secretsEntered && hasPasswordInUrl(url, login.password))
              throw loginError("JOURNAL_LOGIN_INSECURE_FORM");
            const body = method === "POST" ? (request.postData() ?? "") : undefined;
            if (body && Buffer.byteLength(body) > 256 * 1024)
              throw loginError("JOURNAL_LOGIN_REQUEST_TOO_LARGE");
            if (network && origins.has(url.origin)) {
              await network.guard(request.url());
              if (requestOperationId !== operationId) {
                await request.abort();
                return;
              }
              nativeRequests.add(request);
              await request.continue();
              return;
            }
            const headers = request.headers();
            const response = await (this.fetchPage ?? fetchRemotePage)(request.url(), {
              method: method as "GET" | "POST" | "OPTIONS",
              body,
              contentType: headers["content-type"],
              requestedWith: headers["x-requested-with"],
              referer: headers.referer,
              cookie: headers.cookie,
              userAgent: headers["user-agent"],
              accept: headers.accept,
              browserHeaders: headers,
              // CSRF tokens and other application headers belong to this
              // checked destination, never to an automatically followed host.
              applicationHeaders: origins.has(url.origin)
                ? browserApplicationHeaders(headers)
                : undefined,
              // Preserve the actual browser origin, including SSO calls from
              // the login host to the declared journal host. Chromium still
              // enforces the server's own CORS response headers below.
              origin:
                headers.origin && (origins.has(headers.origin) || headers.origin === "null")
                  ? headers.origin
                  : undefined,
              corsRequestMethod: headers["access-control-request-method"],
              corsRequestHeaders: headers["access-control-request-headers"],
              // Chromium follows each checked redirect through interception,
              // keeping its own cookies, CORS rules and HTTP method semantics.
              followRedirects: false,
              allowHttpErrorResponses:
                !authenticating && mainNavigation && url.origin === journalOrigin
                  ? [402]
                  : undefined,
            });
            if (response.status >= 400) {
              if (!authenticating) throw journalHttpError(response.status, response.text);
              throw loginError(
                secretsEntered ? "JOURNAL_LOGIN_FAILED" : "JOURNAL_LOGIN_PAGE_HTTP_ERROR",
              );
            }
            const contentType =
              response.contentType ?? (navigation ? "text/html" : "application/javascript");
            let destination: URL | undefined;
            if (response.location) {
              destination = new URL(response.location, request.url());
              if (
                !origins.has(destination.origin) ||
                destination.protocol !== "https:" ||
                destination.username ||
                destination.password
              )
                throw loginError("JOURNAL_LOGIN_REDIRECT_BLOCKED");
              if (secretsEntered && hasPasswordInUrl(destination, login.password))
                throw loginError("JOURNAL_LOGIN_INSECURE_FORM");
            }
            await request.respond({
              status: response.status,
              body: response.text,
              headers: {
                "content-type": `${contentType.replace(/;\s*charset\s*=\s*[^;]+/i, "")}; charset=utf-8`,
                ...(destination ? { location: destination.href } : {}),
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
            if (mainNavigation)
              networkError = safeTransportError(
                error,
                authenticating ? loginFailureCode : articleFailureCode,
              );
            else if (
              authenticating &&
              submissionStarted &&
              (["POST", "OPTIONS"].includes(method) ||
                request.redirectChain().some((previous) => previous.method() === "POST"))
            )
              // Background analytics/session calls can fail after a successful
              // login. Keep their error for an unconfirmed submission only;
              // they must not win the race against the main document.
              submissionError ??= safeTransportError(error, "JOURNAL_LOGIN_FAILED");
            await request.abort().catch(() => {});
            if (networkError) rejectNetwork(networkError);
          }
        };
        const page = await createScrapingPage(
          browser,
          network ? publicBrowserOptions(await browser.version()) : {},
          context,
        );
        if (network) {
          const nativeNetwork = network;
          await prepareJournalNativePage(page);
          closeTargetGuard = await blockJournalAuxiliaryTargets(browser, context, page);
          const fail = (error: unknown) => {
            if (networkError) return;
            networkError = safeTransportError(
              error,
              authenticating ? loginFailureCode : articleFailureCode,
            );
            rejectNetwork(networkError);
          };
          await watchBrowserResponseSize(page, fail, nativeNetwork);
          page.on("response", (response) => {
            const request = response.request();
            if (
              !nativeRequests.has(request) ||
              requestOperations.get(request) !== operationId ||
              response.status() < 400
            )
              return;
            if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
              if (
                authenticating &&
                submissionStarted &&
                (["POST", "OPTIONS"].includes(request.method()) ||
                  request.redirectChain().some((previous) => previous.method() === "POST"))
              )
                submissionError ??= loginError();
              return;
            }
            const responseOperationId = operationId;
            void (async () => {
              let html: string | undefined;
              if (
                !authenticating &&
                response.status() === 402 &&
                /(?:text\/html|application\/xhtml\+xml)/i.test(
                  response.headers()["content-type"] ?? "",
                )
              ) {
                html = await response.text().catch(() => undefined);
              }
              if (responseOperationId !== operationId) return;
              fail(
                authenticating
                  ? loginError(
                      secretsEntered ? "JOURNAL_LOGIN_FAILED" : "JOURNAL_LOGIN_PAGE_HTTP_ERROR",
                    )
                  : journalHttpError(response.status(), html),
              );
            })().catch(() => {
              if (responseOperationId !== operationId) return;
              fail(
                authenticating ? loginError(loginFailureCode) : journalHttpError(response.status()),
              );
            });
          });
          page.on("requestfailed", (request) => {
            if (
              nativeRequests.has(request) &&
              requestOperations.get(request) === operationId &&
              request.isNavigationRequest() &&
              request.frame() === page.mainFrame()
            )
              fail(nativeNetwork.failure(request.url(), request.failure()?.errorText));
          });
        }
        const loginLifecycle = await page.createCDPSession();
        await loginLifecycle.send("Page.enable");
        const { frameTree } = await loginLifecycle.send("Page.getFrameTree");
        loginLifecycle.on("Page.frameNavigated", ({ frame }) => {
          // Unlike Puppeteer's framenavigated event, this excludes pushState
          // and replaceState: accepting the homepage requires a new document.
          if (authenticating && submissionStarted && frame.id === frameTree.frame.id)
            submittedMainNavigation = true;
        });
        await interceptRequests(page, handleRequest);
        page.setDefaultTimeout(this.timeoutMs);
        const execute = async <R>(
          action: () => Promise<R>,
          abort: () => Promise<void> = () => context.close().catch(() => {}),
        ): Promise<R> => {
          operationId++;
          network?.beginLoad();
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
                    authenticating ? loginFailureCode : articleFailureCode,
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
          const previousSignals = (await page.evaluate(connectionStateInPage)).signals;
          const successAlreadyVisible = login.config.successSelector
            ? await isVisible(page, visibleJournalSelector(login.config.successSelector))
            : false;
          secretsEntered = true;
          observer?.("Saisie des identifiants dans le formulaire de connexion.");
          await fillLoginForm(page, login);
          observer?.("Champs de connexion remplis et vérifiés.");
          await (
            await uniqueVisible(page, login.config.submitSelector, "JOURNAL_LOGIN_SUBMIT_NOT_FOUND")
          ).dispose();
          observer?.("Envoi du formulaire et vérification de la connexion.");
          loginFailureCode = "JOURNAL_LOGIN_SUBMIT_FAILED";
          submissionStarted = true;
          await page.locator(visibleJournalSelector(login.config.submitSelector)).click();
          loginFailureCode = "JOURNAL_LOGIN_FAILED";
          const confirmation = await confirmConnection(page, previousSignals, this.timeoutMs, {
            journalOrigin,
            mainNavigation: () => submittedMainNavigation,
            successSelector: successAlreadyVisible ? null : login.config.successSelector,
            invalidSuccessSelector: successAlreadyVisible,
            failure: () =>
              submissionError ??
              (successAlreadyVisible
                ? loginError("JOURNAL_LOGIN_SUCCESS_SELECTOR_INVALID")
                : login.config.successSelector
                  ? loginError()
                  : undefined),
          });
          // Some publishers finish their SSO cookies in an AJAX request from
          // the homepage. Let those requests settle before reading an article,
          // without waiting indefinitely for polling or analytics.
          try {
            await page.waitForNetworkIdle({ idleTime: 300, timeout: 2500 });
          } catch (error) {
            if (!(error instanceof TimeoutError)) throw error;
          }
          authenticating = false;
          if (confirmation === "homepage")
            observer?.("Connexion acceptée après redirection vers l'accueil du journal.");
          observer?.("Connexion au journal vérifiée dans cette session.");
        });
        // A session can also live in sessionStorage or window.name. Navigate
        // the authenticated tab itself, retaining those values as a normal
        // browser visit does instead of transferring only cookies to a new tab.
        const readPage: JournalPageReader = async (url, notify) => {
          const target = articleTarget(domain, url);
          if (expired || !browser.connected || page.isClosed())
            throw loginError("JOURNAL_SESSION_EXPIRED");
          articleFailureCode = "JOURNAL_ARTICLE_PAGE_FAILED";
          try {
            return await execute(
              async () => {
                const observer = notify;

                observer?.("Chargement de l'article avec la session authentifiée.");
                await navigateScrapingPage(page, target.href, { waitForAllResources: false });
                if (networkError) throw networkError;
                network?.assertWithinBudget();
                articleFailureCode = "JOURNAL_ARTICLE_CONTENT_FAILED";
                observer?.("Document principal de l'article chargé dans l'onglet authentifié.");
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
                network?.assertWithinBudget();
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
              async () => {
                // Stop a rejected navigation before the next serial read,
                // preserving the tab's session storage for that next article.
                const session = await page.createCDPSession().catch(() => undefined);
                if (!session) return;
                try {
                  await session.send("Page.stopLoading").catch(() => {});
                } finally {
                  await session.detach().catch(() => {});
                }
              },
            );
          } catch (error) {
            if (error instanceof AppError && error.code === "JOURNAL_SESSION_EXPIRED")
              expired = true;
            throw error;
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
        await closeTargetGuard?.().catch(() => {});
        await network?.close().catch(() => {});
      }
    });
  }
}

// A newly visible logout control can confirm sites that keep the current URL.
// A post-submission main-document redirect to the journal homepage is also
// accepted, without depending on a publisher's account-menu implementation.
function connectionStateInPage() {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0" ||
        ancestor.hasAttribute("hidden") ||
        ancestor.hasAttribute("inert")
      )
        return false;
    }
    return true;
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
    ready: document.readyState !== "loading" && !!document.body,
  };
}

async function confirmConnection(
  page: Page,
  previousSignals: string[],
  timeoutMs: number,
  options: {
    journalOrigin: string;
    mainNavigation: () => boolean;
    successSelector?: string | null;
    invalidSuccessSelector: boolean;
    failure: () => AppError | undefined;
  },
) {
  const before = new Set(previousSignals);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(connectionStateInPage);
      if (state.ready && !state.passwordVisible) {
        const current = new URL(page.url());
        if (
          options.mainNavigation() &&
          current.origin === options.journalOrigin &&
          current.pathname === "/"
        )
          return "homepage";
        if (!options.invalidSuccessSelector && state.signals.some((signal) => !before.has(signal)))
          return "logout";
        if (options.successSelector) {
          const matches = await page.$$eval(
            visibleJournalSelector(options.successSelector),
            (elements) => elements.length,
          );
          if (matches > 1) throw loginError("JOURNAL_LOGIN_SELECTOR_AMBIGUOUS");
          if (matches === 1) return "selector";
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      // A form submission can replace the document during this check.
      if (page.isClosed()) throw loginError();
    }
    await delay(100);
  }
  throw options.failure() ?? loginError("JOURNAL_LOGIN_UNVERIFIED");
}

async function uniqueVisible(
  page: Page,
  selector: string,
  missingCode?: string,
): Promise<ElementHandle<Element>> {
  const visibleSelector = visibleJournalSelector(selector);
  const element = await page.waitForSelector(visibleSelector, { visible: true }).catch((error) => {
    if (missingCode) throw loginError(missingCode);
    throw error;
  });
  if (!element || (await page.$$eval(visibleSelector, (elements) => elements.length)) !== 1) {
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
    // JavaScript forms often omit method=post and prevent native submit.
    // The network guard rejects an actual password-bearing GET instead.
    const valid = await field.evaluate(
      (node, password) =>
        node instanceof HTMLInputElement &&
        (password ? node.type === "password" : ["email", "text"].includes(node.type)),
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
          .locator(visibleJournalSelector(selector))
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
    const matches = (selector: string, value: string) =>
      page.$$eval(
        visibleJournalSelector(selector),
        (fields, value) =>
          fields.length === 1 && fields[0] instanceof HTMLInputElement && fields[0].value === value,
        value,
      );
    const filled =
      (await matches(login.config.emailSelector, login.email)) &&
      (await matches(login.config.passwordSelector, login.password));
    if (filled) return;
  }
  throw loginError("JOURNAL_LOGIN_FIELDS_UNFILLED");
}

async function assertArticleAccess(page: Page, login: JournalLogin, journalOrigin: string) {
  if (new URL(page.url()).origin !== journalOrigin) throw loginError("JOURNAL_SESSION_EXPIRED");
  if (
    (await isVisible(page, visibleJournalSelector(login.config.passwordSelector))) &&
    (await isVisible(page, visibleJournalSelector(login.config.emailSelector)))
  )
    throw loginError("JOURNAL_SESSION_EXPIRED");
  if (
    await isVisible(
      page,
      visibleJournalSelector(
        ".paywall, #paywall, [data-paywall], #challenge-form, #cf-challenge-running, #captcha",
      ),
    )
  )
    throw new AppError(
      422,
      "L'article reste protégé après connexion. La session ou l'abonnement ne donne pas accès au contenu complet.",
      "JOURNAL_ARTICLE_ACCESS_DENIED",
    );
}
