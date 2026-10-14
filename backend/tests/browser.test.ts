import { test, expect } from "bun:test";
import { createServer } from "node:http";
import type { Page } from "puppeteer";
import {
  launchScrapingBrowser,
  createScrapingPage,
  interceptRequests,
  scrapingBrowser,
} from "../src/browser";

test("stealth page hooks wait for the main frame instead of accessing an uninitialized page", async () => {
  const browser = await launchScrapingBrowser();
  try {
    let ready = false;
    let injections = 0;
    const page = {
      isClosed: () => false,
      browser: () => browser,
      getDefaultTimeout: () => 1000,
      mainFrame: () => {
        if (!ready) throw new Error("Requesting main frame too early!");
        return {};
      },
      evaluateOnNewDocument: async () => {
        if (!ready) throw new Error("Requesting main frame too early!");
        injections++;
        return { identifier: String(injections) };
      },
    } as unknown as Page;
    const plugin = scrapingBrowser.plugins.find(
      (plugin) => plugin.name === "stealth/evasions/navigator.webdriver",
    );
    expect(plugin).toBeDefined();
    const initialization = plugin!.onPageCreated(page);
    const readyTimer = setTimeout(() => {
      ready = true;
    }, 30);
    try {
      await initialization;
      expect(injections).toBe(1);
    } finally {
      clearTimeout(readyTimer);
    }
  } finally {
    await browser.close();
  }
}, 15000);

test("stealth skips a page closed before its main frame is initialized", async () => {
  const browser = await launchScrapingBrowser();
  try {
    let closed = false;
    let injections = 0;
    const page = {
      isClosed: () => closed,
      browser: () => browser,
      getDefaultTimeout: () => 1000,
      mainFrame: () => {
        throw new Error("Requesting main frame too early!");
      },
      evaluateOnNewDocument: async () => {
        injections++;
        return { identifier: "unused" };
      },
    } as unknown as Page;
    const plugin = scrapingBrowser.plugins.find(
      (plugin) => plugin.name === "stealth/evasions/navigator.webdriver",
    )!;
    const initialization = plugin.onPageCreated(page);
    const closeTimer = setTimeout(() => {
      closed = true;
    }, 30);
    try {
      await initialization;
      expect(injections).toBe(0);
    } finally {
      clearTimeout(closeTimer);
    }
  } finally {
    await browser.close();
  }
}, 15000);

test("stealth setup failures on a live page still reach the page creator", async () => {
  const browser = await launchScrapingBrowser();
  try {
    const failure = new Error("Synthetic page setup failure");
    const page = {
      isClosed: () => false,
      browser: () => browser,
      getDefaultTimeout: () => 1000,
      mainFrame: () => ({}),
      evaluateOnNewDocument: async () => {
        throw failure;
      },
    } as unknown as Page;
    const plugin = scrapingBrowser.plugins.find(
      (plugin) => plugin.name === "stealth/evasions/navigator.webdriver",
    )!;
    await expect(plugin.onPageCreated(page)).rejects.toBe(failure);
    await expect(scrapingBrowser.waitForPagePlugins(page)).rejects.toBe(failure);
  } finally {
    await browser.close();
  }
}, 15000);

test("production browsers apply stealth, isolate sessions and deny WebSockets and service workers", async () => {
  const browser = await launchScrapingBrowser();
  try {
    const first = await createScrapingPage(browser);
    const second = await createScrapingPage(browser);
    for (const page of [first, second]) {
      await interceptRequests(page, async (request) => {
        await request.respond({ contentType: "text/html", body: "<main>Public page</main>" });
      });
      await page.goto("https://fixture.example/session");
    }
    await first.evaluate(() => {
      document.cookie = "session=first; Path=/; Secure";
    });
    expect(await first.evaluate(() => navigator.webdriver)).toBe(false);
    expect(await first.evaluate(() => document.cookie)).toContain("session=first");
    expect(await second.evaluate(() => document.cookie)).toBe("");
    expect(
      await first.evaluate(async () => {
        let socketBlocked = false;
        let workerBlocked = false;
        try {
          new WebSocket("wss://fixture.example/socket");
        } catch {
          socketBlocked = true;
        }
        try {
          await navigator.serviceWorker.register("/worker.js");
        } catch {
          workerBlocked = true;
        }
        return { socketBlocked, workerBlocked };
      }),
    ).toEqual({ socketBlocked: true, workerBlocked: true });
  } finally {
    await browser.close();
  }
}, 15000);

test("unintercepted browser pages cannot send traffic outside the guarded transport", async () => {
  let received = 0;
  const server = createServer((_request, response) => {
    received++;
    response.end("must not be reached");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  let browser;
  try {
    browser = await launchScrapingBrowser();
    // A popup or worker without interception must not fall back to native HTTP.
    const page = await browser.newPage();
    await expect(
      page.goto(`http://127.0.0.1:${address.port}/escape`, { timeout: 3000 }),
    ).rejects.toThrow();
    expect(received).toBe(0);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15000);
