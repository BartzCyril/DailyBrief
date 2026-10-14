import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "puppeteer";
import { createScrapingPage, interceptRequests, launchScrapingBrowser } from "../src/browser";
import {
  blockJournalAuxiliaryTargets,
  prepareJournalNativePage,
} from "../src/journal-native-guard";

let browser: Browser;
beforeAll(async () => {
  browser = await launchScrapingBrowser();
});
afterAll(async () => {
  await browser?.close();
});

async function guardedPage(
  html: string,
  use: (
    page: Page,
    requests: { path: string; method: string }[],
    popups: () => number,
  ) => Promise<void>,
  frameHtml = "<p>Child frame</p>",
) {
  const context = await browser.createBrowserContext();
  try {
    const page = await createScrapingPage(browser, {}, context);
    const requests: { path: string; method: string }[] = [];
    let opened = 0;
    page.on("popup", () => opened++);
    await prepareJournalNativePage(page);
    await interceptRequests(page, async (request) => {
      const path = new URL(request.url()).pathname;
      requests.push({ path, method: request.method() });
      await request.respond({
        status: 200,
        contentType: "text/html",
        body: path === "/login" ? html : path === "/frame" ? frameHtml : "<p>Completed</p>",
      });
    });
    await page.goto("https://publisher.example/login", { waitUntil: "load" });
    await use(page, requests, () => opened);
  } finally {
    await context.close();
  }
}

test("disables popup and worker channels before publisher scripts in the page and child frames", async () => {
  await guardedPage('<iframe src="/frame"></iframe>', async (page, requests, popups) => {
    for (const frame of page.frames()) {
      const result = await frame.evaluate(() => {
        const denied: string[] = [];
        for (const name of ["Worker", "SharedWorker"] as const) {
          try {
            new window[name]("https://publisher.example/mutation-worker.js");
          } catch (error) {
            denied.push(error instanceof DOMException ? error.name : "OtherError");
          }
        }
        return {
          denied,
          opened: window.open("https://publisher.example/mutation", "_blank"),
          protected: ["Worker", "SharedWorker", "open"].every((name) => {
            const descriptor = Object.getOwnPropertyDescriptor(window, name);
            return descriptor?.configurable === false && descriptor.writable === false;
          }),
        };
      });
      expect(result).toEqual({
        denied: ["SecurityError", "SecurityError"],
        opened: null,
        protected: true,
      });
    }
    expect(popups()).toBe(0);
    expect(requests.some((request) => request.path.startsWith("/mutation"))).toBe(false);
  });
});

test("locks service worker registration through both the container and its prototype in every frame", async () => {
  await guardedPage('<iframe src="/frame"></iframe>', async (page, requests) => {
    for (const frame of page.frames()) {
      const result = await frame.evaluate(async () => {
        const attempts = [
          navigator.serviceWorker.register("/mutation-sw.js"),
          ServiceWorkerContainer.prototype.register.call(
            navigator.serviceWorker,
            "/mutation-sw-prototype.js",
          ),
        ];
        const denied = await Promise.all(
          attempts.map((attempt) =>
            attempt.then(
              () => "Allowed",
              (error: unknown) => (error instanceof DOMException ? error.name : "OtherError"),
            ),
          ),
        );
        return {
          denied,
          protected: [navigator.serviceWorker, ServiceWorkerContainer.prototype].every((object) => {
            const descriptor = Object.getOwnPropertyDescriptor(object, "register");
            return descriptor?.configurable === false && descriptor.writable === false;
          }),
        };
      });
      expect(result).toEqual({ denied: ["SecurityError", "SecurityError"], protected: true });
    }
    expect(requests.some((request) => request.path.startsWith("/mutation-sw"))).toBe(false);
  });
});

test.each(["native", "submit", "requestSubmit", "late-target"])(
  "keeps %s form submission in the guarded tab instead of opening a new native tab",
  async (mode) => {
    await guardedPage(
      '<base target="_blank"><form id="login" method="post" action="/done" target="subscriber-popup"><input type="email" name="email" value="reader@example.com"><input type="password" name="password" value="test-password"><button id="send" formtarget="_blank">Login</button></form>',
      async (page, requests, popups) => {
        const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
        void navigation.catch(() => {});
        if (mode === "native" || mode === "late-target") {
          if (mode === "late-target")
            await page.evaluate(() => {
              document.querySelector("form")!.addEventListener("submit", (event) => {
                (event.target as HTMLFormElement).target = "late-popup";
                (event as SubmitEvent).submitter!.setAttributeNS(null, "formtarget", "_blank");
              });
            });
          await page.click("#send");
        } else
          await page.evaluate((mode) => {
            const form = document.querySelector("form")!;
            if (mode === "submit") form.submit();
            else form.requestSubmit(document.querySelector("button")!);
          }, mode);
        await navigation;
        expect(page.url()).toBe("https://publisher.example/done");
        expect(requests.filter((request) => request.path === "/done")).toEqual([
          { path: "/done", method: "POST" },
        ]);
        expect(popups()).toBe(0);
        expect(await page.browserContext().pages()).toHaveLength(1);
      },
    );
  },
);

test.each(["explicit", "base", "dynamic"])(
  "keeps links with %s popup targets in the guarded tab",
  async (mode) => {
    await guardedPage(
      `<base target="_blank"><a id="link" href="/done"${mode === "explicit" ? ' target="_blank"' : ""}>Read</a>`,
      async (page, requests, popups) => {
        if (mode === "dynamic")
          await page.evaluate(() => {
            document.querySelector("a")!.target = "named-reader";
          });
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click("#link"),
        ]);
        expect(page.url()).toBe("https://publisher.example/done");
        expect(requests.filter((request) => request.path === "/done")).toEqual([
          { path: "/done", method: "GET" },
        ]);
        expect(popups()).toBe(0);
        expect(await page.browserContext().pages()).toHaveLength(1);
      },
    );
  },
);

test("retains parent-frame form navigation and normalizes dynamically injected target attributes", async () => {
  await guardedPage(
    '<iframe src="/frame"></iframe>',
    async (page, requests, popups) => {
      const frame = page.frames().find((frame) => frame.url().endsWith("/frame"))!;
      expect(
        await frame.evaluate(() => {
          const form = document.querySelector("form")!;
          form.insertAdjacentHTML("beforeend", '<a href="/done" target="injected-popup">Read</a>');
          return form.target;
        }),
      ).toBe("_parent");
      await frame.waitForFunction(() => document.querySelector("a")!.target === "_self");
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        frame.click("#submit"),
      ]);
      expect(page.url()).toBe("https://publisher.example/done");
      expect(requests.filter((request) => request.path === "/done")).toEqual([
        { path: "/done", method: "POST" },
      ]);
      expect(popups()).toBe(0);
      expect(await page.browserContext().pages()).toHaveLength(1);
    },
    '<form method="post" action="/done" target="_parent"><button id="submit">Login</button></form>',
  );
});

test("closes native popup targets created by forms in a closed shadow tree before page startup", async () => {
  const dedicatedBrowser = await launchScrapingBrowser();
  let release: (() => Promise<void>) | undefined;
  try {
    const context = await dedicatedBrowser.createBrowserContext();
    const page = await createScrapingPage(dedicatedBrowser, {}, context);
    await prepareJournalNativePage(page);
    await interceptRequests(page, async (request) => {
      await request.respond({
        status: 200,
        contentType: "text/html",
        body: `<button id="launch">Launch</button><div id="host"></div><script>
          const shadow = document.getElementById('host').attachShadow({mode:'closed'});
          shadow.innerHTML = '<form action="/mutation-shadow" method="post" target="_blank"><button>Submit</button></form>';
          document.getElementById('launch').onclick = () => shadow.querySelector('button').click();
        </script>`,
      });
    });
    release = await blockJournalAuxiliaryTargets(dedicatedBrowser, context, page);
    await page.goto("https://publisher.example/login", { waitUntil: "load" });
    const observer = await dedicatedBrowser.target().createCDPSession();
    let popupId: string | undefined;
    let resolveDestroyed: () => void = () => {};
    const destroyed = new Promise<void>((resolve) => {
      resolveDestroyed = resolve;
    });
    observer.on("Target.targetCreated", ({ targetInfo }) => {
      if (targetInfo.browserContextId === context.id && targetInfo.type === "page")
        popupId = targetInfo.targetId;
    });
    observer.on("Target.targetDestroyed", ({ targetId }) => {
      if (targetId === popupId) resolveDestroyed();
    });
    await observer.send("Target.setDiscoverTargets", { discover: true });
    popupId = undefined;
    await page.click("#launch");
    await destroyed;
    expect(popupId).toBeDefined();
    expect(page.url()).toBe("https://publisher.example/login");
    expect(await context.pages()).toEqual([page]);
    expect(dedicatedBrowser.defaultBrowserContext().closed).toBe(false);
    await observer.detach();
  } finally {
    await dedicatedBrowser.close();
    await release?.();
  }
});
