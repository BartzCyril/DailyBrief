import puppeteer from "puppeteer";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type {
  Browser,
  BrowserContext,
  ElementHandle,
  HTTPRequest,
  LaunchOptions,
  Page,
} from "puppeteer";

// Register once: every production browser uses the same Puppeteer/stealth setup.
export const scrapingBrowser = addExtra(puppeteer);
scrapingBrowser.use(StealthPlugin());

export function browserExecutablePath(): string {
  return process.env.CHROMIUM_EXECUTABLE_PATH || puppeteer.executablePath();
}

export function launchScrapingBrowser(options: LaunchOptions = {}): Promise<Browser> {
  return scrapingBrowser.launch({
    headless: true,
    executablePath: browserExecutablePath(),
    defaultViewport: { width: 1280, height: 720 },
    // Injected HTTP transports fail closed for unintercepted traffic.
    // Native public navigation supplies the DNS-pinned relay via options.args.
    args: ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"],
    ...options,
  });
}

export async function createScrapingPage(
  browser: Browser,
  options: { userAgent?: string; locale?: string } = {},
  existingContext?: BrowserContext,
): Promise<Page> {
  const context = existingContext ?? (await browser.createBrowserContext());
  try {
    const page = await context.newPage();
    if (options.userAgent) await page.setUserAgent(options.userAgent);
    if (options.locale) await page.setExtraHTTPHeaders({ "Accept-Language": options.locale });
    await page.setCacheEnabled(false);
    await page.setBypassServiceWorker(true);
    const session = await page.createCDPSession();
    await session.send("Browser.setDownloadBehavior", {
      behavior: "deny",
      browserContextId: context.id,
    });
    await session.detach();
    await page.evaluateOnNewDocument(() => {
      // These channels cannot pass through the guarded HTTP transport.
      Object.defineProperty(window, "WebSocket", {
        value: class {
          constructor() {
            throw new DOMException("WebSockets are disabled", "SecurityError");
          }
        },
      });
      if (navigator.serviceWorker)
        navigator.serviceWorker.register = () =>
          Promise.reject(new DOMException("Service workers are disabled", "SecurityError"));
    });
    return page;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

const requestGuards = new WeakMap<Page, (request: HTTPRequest) => Promise<void>>();

export function setRequestGuard(page: Page, guard: (request: HTTPRequest) => Promise<void>): void {
  requestGuards.set(page, guard);
}

export async function interceptRequests(
  page: Page,
  handler: (request: HTTPRequest) => Promise<void>,
): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    // Full Chrome requests a default favicon that headless shell did not load.
    if (request.resourceType() === "other" && new URL(request.url()).pathname === "/favicon.ico") {
      void request.abort().catch(() => {});
      return;
    }
    // Closing a timed-out page may race an asynchronous transport response.
    void (async () => {
      await requestGuards.get(page)?.(request);
      await handler(request);
    })().catch(async () => {
      if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => {});
    });
  });
}

export const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function navigateScrapingPage(page: Page, url: string): Promise<void> {
  // Puppeteer's lifecycle networkidle0 can add a long delay to each Chromium
  // navigation. Track requests directly, retaining the 500 ms idle interval.
  await Promise.all([
    page.goto(url, { waitUntil: "load" }),
    page.waitForNetworkIdle({ idleTime: 500, timeout: page.getDefaultNavigationTimeout() }),
  ]);
}

export async function waitForClickTarget(
  button: ElementHandle<Element>,
  timeout: number,
): Promise<void> {
  await button.scrollIntoView();
  const ready = await button.frame.waitForFunction(
    (element) => {
      if (!element.isConnected) return false;
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(innerHeight, rect.bottom);
      if (right <= left || bottom <= top) return false;
      const target = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return Boolean(target && (target === element || element.contains(target)));
    },
    { timeout, polling: 100 },
    button,
  );
  await ready.dispose();
}

export async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page.$$eval(selector, (elements) =>
    elements.some((element) => {
      const style = getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        Boolean(element.getClientRects().length)
      );
    }),
  );
}
