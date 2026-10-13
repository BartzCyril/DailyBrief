import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { launchScrapingBrowser, createScrapingPage, interceptRequests } from "../src/browser";

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
