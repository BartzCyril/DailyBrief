import { afterAll, beforeAll, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { chromium } from "playwright";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { BrowserNetwork, type BrowserNetworkFactory } from "../src/browser-network";
import { validateRemoteUrl } from "../src/network";
import { renderPublicSelectorPage, OllamaSelectorAnalysisProvider } from "../src/selector-analysis";
import { OllamaClient } from "../src/ai";
import { readConfig } from "../src/config";
import { ArticleBrowser } from "../src/article-browser";
import { MAX_REMOTE_BYTES } from "../src/remote-response";
import { ScrapingService } from "../src/scraping";
import { nativeTlsFixture } from "./fixtures/native-tls";
import { diagnosePage } from "../scripts/diagnose-page";
import { UpstreamHttpError } from "../src/errors";
import { ArticleContentService } from "../src/article-content";

const requests: { path: string; method: string; host?: string; cookie?: string; ua?: string }[] =
  [];
let port = 0;
const server = createServer((request, response) => {
  const path = new URL(request.url!, "http://fixture").pathname;
  requests.push({
    path,
    method: request.method!,
    host: request.headers.host,
    cookie: request.headers.cookie,
    ua: request.headers["user-agent"],
  });
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (path === "/native-notice") {
    response.end(
      `<a class="primarydoc" href="http://ads.test:${port}/external-article">Consulter le document</a>`,
    );
    return;
  }
  if (path === "/redirect-public") {
    response.writeHead(302, { Location: `http://ads.test:${port}/landing-public` }).end();
    return;
  }
  if (path === "/redirect-private") {
    response.writeHead(302, { Location: `http://127.0.0.1:${port}/private` }).end();
    return;
  }
  if (path === "/denied") {
    response.writeHead(403).end("private-error-token");
    return;
  }
  if (path === "/batch-cross") {
    response
      .writeHead(307, {
        Location: `http://ads.test:${port}/leaked-post`,
        "Access-Control-Allow-Origin": "*",
      })
      .end();
    return;
  }
  if (path.startsWith("/batch")) {
    if (path === "/batch-denied") {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ title: "Article supplémentaire natif" }));
    return;
  }
  if (path === "/leaked-post") {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ title: "Article qui ne doit jamais être chargé" }));
    return;
  }
  if (path.startsWith("/load-more")) {
    const batch =
      path === "/load-more-denied"
        ? "/batch-denied"
        : path === "/load-more-cross"
          ? "/batch-cross"
          : "/batch";
    response.end(
      `<main><article><h2><a href="/first">Premier article</a></h2></article><button class="more" onclick="fetch('http://ads.test:${port}/unrelated-post',{method:'POST'}).catch(()=>{});fetch('${batch}',{method:'POST',body:'batch-request'}).then(r=>r.json()).then(data=>{document.querySelector('main').insertAdjacentHTML('beforeend','<article><h2><a href=&quot;/next&quot;>'+data.title+'</a></h2></article>');this.remove()}).catch(()=>{})">Plus</button></main>`,
    );
    return;
  }
  if (path === "/large") {
    response.writeHead(200, { "Content-Encoding": "gzip" });
    response.end(gzipSync(Buffer.from(`<main>${"large ".repeat(MAX_REMOTE_BYTES)}</main>`)));
    return;
  }
  if (path === "/latin") {
    response.setHeader("Content-Type", "text/html");
    response.end(
      Buffer.from(
        '<!doctype html><meta charset="iso-8859-1"><main><article><h2><a href="/article">Données du cloud en été</a></h2></article></main>',
        "latin1",
      ),
    );
    return;
  }
  if (path === "/api") {
    if (request.headers.cookie !== "native-session=temporary") {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ title: "Article créé par JavaScript" }));
    return;
  }
  if (path === "/hydration.js") {
    response.setHeader("Content-Type", "application/javascript; charset=utf-8");
    response.end(
      `fetch('/api').then(r=>r.json()).then(data=>{document.querySelector('main').innerHTML='<article><h2><a href="/article">'+data.title+'</a></h2><p>${"Contenu complet après chargement navigateur. ".repeat(12)}</p></article>';}); fetch('/mutation',{method:'POST',body:'must-not-send'}).catch(()=>{});`,
    );
    return;
  }
  if (path === "/hydrated") {
    response.setHeader("Set-Cookie", "native-session=temporary; Path=/; HttpOnly; SameSite=Lax");
    response.end(
      '<main></main><style>#hidden{display:none}</style><input id="hidden" value="private-input-value"><script src="/hydration.js"></script>',
    );
    return;
  }
  response.end(
    `<main><article><h2><a href="/article">Article public</a></h2></article></main><iframe src="http://ads.test:${port}/denied"></iframe><iframe src="http://127.0.0.1:${port}/private"></iframe>`,
  );
});
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  port = address.port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Only this fixture factory maps invented public names to our local HTTP server.
// Production has no allow-private environment switch or configurable address bypass.
const networkFactory: BrowserNetworkFactory = () =>
  BrowserNetwork.create(async (value) => {
    const url = new URL(value);
    if (["publisher.test", "ads.test"].includes(url.hostname))
      return { url, address: "127.0.0.1", family: 4 };
    return validateRemoteUrl(value);
  });
const url = (path: string) => `http://publisher.test:${port}${path}`;

test("Chromium loads the actual URL, manages cookies and reads the hydrated HTML without HTTP pre-download", async () => {
  const start = requests.length;
  const page = await renderPublicSelectorPage(url("/hydrated"), undefined, networkFactory);
  expect(page.html).toContain("Article créé par JavaScript");
  expect(page.html).toContain('id="hidden" value="private-input-value" data-dailybrief-hidden=""');
  expect(page.status).toBe(200);
  const sent = requests.slice(start);
  expect(sent.some((item) => item.path === "/hydration.js")).toBe(true);
  expect(
    sent.some((item) => item.path === "/api" && item.cookie === "native-session=temporary"),
  ).toBe(true);
  expect(sent.every((item) => item.method === "GET")).toBe(true);
  expect(sent[0]?.host).toBe(`publisher.test:${port}`);
  expect(sent[0]?.cookie).toBeUndefined();
  expect(sent[0]?.ua).toMatch(/Chrome\/\d+\./);
}, 45000);

test("native browser sessions remain temporary and isolated between analyses", async () => {
  const start = requests.length;
  await renderPublicSelectorPage(url("/hydrated"), undefined, networkFactory);
  expect(requests.slice(start).find((item) => item.path === "/hydrated")?.cookie).toBeUndefined();
}, 45000);

test("Chromium decodes a legacy meta charset before selector AI receives the rendered page", async () => {
  const config = readConfig({
    DATABASE_URL: "postgresql://localhost/test",
    SESSION_SECRET: "x".repeat(32),
  });
  let called = false;
  const client = new OllamaClient(config, async (_url, init) => {
    called = true;
    const body = JSON.parse(String(init?.body));
    expect(body.prompt).toContain("Données du cloud en été");
    return new Response(
      JSON.stringify({
        done: true,
        response: JSON.stringify({
          articleSelector: "article",
          titleSelector: "h2",
          linkSelector: "h2 a",
          mode: "SCROLL",
          scroll: { maxScrolls: 0, waitAfterScrollMs: 800 },
        }),
      }),
    );
  });
  const provider = new OllamaSelectorAnalysisProvider(config, {
    client,
    renderPage: (value) => renderPublicSelectorPage(value, undefined, networkFactory),
  });
  const result = await provider.analyze({ kind: "SCRAPING", url: url("/latin") });
  expect(result.complete).toBe(true);
  expect(called).toBe(true);
}, 45000);

test("native redirects cannot reach private addresses, including Chromium's usual loopback proxy bypass", async () => {
  const start = requests.length;
  await assert.rejects(
    renderPublicSelectorPage(url("/redirect-private"), undefined, networkFactory),
    { code: "UNSAFE_URL" },
  );
  expect(requests.slice(start).some((item) => item.path === "/private")).toBe(false);
}, 45000);

test("blocked advertising frames preserve a successful native main page", async () => {
  const start = requests.length;
  const page = await renderPublicSelectorPage(url("/frames"), undefined, networkFactory);
  expect(page.html).toContain("Article public");
  expect(requests.slice(start).some((item) => item.path === "/private")).toBe(false);
}, 45000);

test("native main page HTTP errors keep their status without exposing page content or URL tokens", async () => {
  await assert.rejects(
    renderPublicSelectorPage(url("/denied?token=private-query-token"), undefined, networkFactory),
    (error: unknown) => {
      expect(error).toMatchObject({ code: "UPSTREAM_ERROR", upstreamStatus: 403 });
      expect(String(error)).toContain("HTTP 403");
      expect(JSON.stringify(error)).not.toMatch(/private-(query|error)-token/);
      return true;
    },
  );
}, 45000);

test("native rendering bounds inflated HTTP response sizes before using a compressed oversized page", async () => {
  await assert.rejects(renderPublicSelectorPage(url("/large"), undefined, networkFactory), {
    code: "RESPONSE_TOO_LARGE",
  });
}, 45000);

test("article rendering shares native navigation and includes hydrated full article text", async () => {
  const page = await new ArticleBrowser(undefined, networkFactory).render(url("/hydrated"));
  expect(page.html).toContain("Contenu complet après chargement navigateur.");
  expect(page.url).toBe(url("/hydrated"));
}, 45000);

test("native source validation and scraping collect the same JavaScript-rendered article", async () => {
  const service = new ScrapingService(undefined, networkFactory);
  const config = {
    articleSelector: "article",
    titleSelector: "h2",
    linkSelector: "h2 a",
    descriptionSelector: "p",
    mode: "SCROLL" as const,
    scroll: { maxScrolls: 0, waitAfterScrollMs: 100 },
  };
  await service.validateFirstPage(url("/hydrated"), config);
  const result = await service.collect(url("/hydrated"), config);
  expect(result.articles).toHaveLength(1);
  expect(result.articles[0]?.title).toBe("Article créé par JavaScript");
  expect(result.articles[0]?.url).toBe(url("/article"));
}, 45000);

const loadMore = {
  articleSelector: "article",
  titleSelector: "h2",
  linkSelector: "h2 a",
  mode: "LOAD_MORE" as const,
  loadMore: { buttonSelector: ".more", waitTimeoutMs: 1000 },
};
test("native load-more scraping waits for the real same-origin AJAX POST and collects its new article", async () => {
  const start = requests.length;
  const result = await new ScrapingService(undefined, networkFactory).collect(
    url("/load-more"),
    loadMore,
  );
  expect(result.articles.map((item) => item.title)).toEqual([
    "Premier article",
    "Article supplémentaire natif",
  ]);
  expect(
    requests.slice(start).some((item) => item.path === "/batch" && item.method === "POST"),
  ).toBe(true);
}, 45000);

test("native scraping does not report a denied AJAX batch as a successful collection", async () => {
  await assert.rejects(
    new ScrapingService(undefined, networkFactory).collect(url("/load-more-denied"), loadMore),
    { code: "UPSTREAM_ERROR", upstreamStatus: 403 },
  );
}, 45000);

test("a native 307 redirect cannot forward an AJAX POST to another origin", async () => {
  const start = requests.length;
  await assert.rejects(
    new ScrapingService(undefined, networkFactory).collect(url("/load-more-cross"), loadMore),
    { code: "UNSAFE_URL" },
  );
  expect(requests.slice(start).some((item) => item.path === "/leaked-post")).toBe(false);
}, 45000);

test("native public redirects work and article hostname restrictions block a different journal before loading it", async () => {
  const page = await renderPublicSelectorPage(url("/redirect-public"), undefined, networkFactory);
  expect(new URL(page.url).hostname).toBe("ads.test");
  const start = requests.length;
  await assert.rejects(
    new ArticleBrowser(undefined, networkFactory).render(
      url("/redirect-public"),
      undefined,
      "publisher.test",
    ),
    { code: "JOURNAL_REDIRECT_BLOCKED" },
  );
  expect(requests.slice(start).some((item) => item.path === "/landing-public")).toBe(false);
}, 45000);

test("the relay revalidates and pins the destination instead of trusting earlier browser DNS validation", async () => {
  const start = requests.length;
  let checks = 0;
  const rebinding: BrowserNetworkFactory = () =>
    BrowserNetwork.create(async (value) => {
      checks++;
      if (new URL(value).pathname === "/hydrated")
        return { url: new URL(value), address: "127.0.0.1", family: 4 };
      return validateRemoteUrl("http://127.0.0.1/");
    });
  await assert.rejects(renderPublicSelectorPage(url("/hydrated"), undefined, rebinding), {
    code: "UNSAFE_URL",
  });
  expect(checks).toBeGreaterThanOrEqual(3);
  expect(requests.slice(start)).toHaveLength(0);
}, 45000);

// Synthetic self-signed certificate exclusively for a loopback test server.
// Only the standalone protocol test opts out of trust verification; production does not.
const tlsServer = createSecureServer({
  ...nativeTlsFixture(),
  allowHTTP1: true,
});
let tlsPort = 0;
let protocol: string | undefined;
let serverName: string | false | null | undefined;
tlsServer.on("request", (request, response) => {
  protocol = request.httpVersion;
  serverName = (request.socket as import("node:tls").TLSSocket).servername;
  response.end("<main>Page HTTPS native</main>");
});
beforeAll(async () => {
  tlsServer.listen(0, "127.0.0.1");
  await once(tlsServer, "listening");
  const address = tlsServer.address();
  assert(address && typeof address !== "string");
  tlsPort = address.port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
});

test("Chromium owns the HTTPS handshake and negotiates HTTP/2 through the TCP relay", async () => {
  const network = await networkFactory();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    ...network.launchOptions,
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`https://publisher.test:${tlsPort}/`);
    expect(await page.content()).toContain("Page HTTPS native");
    expect(protocol).toBe("2.0");
    expect(serverName).toBe("publisher.test");
  } finally {
    await browser.close();
    await network.close();
  }
}, 45000);

test("the production renderer keeps TLS certificate verification enabled", async () => {
  await assert.rejects(
    renderPublicSelectorPage(`https://publisher.test:${tlsPort}/`, undefined, networkFactory),
    (error: unknown) => {
      expect(error).toMatchObject({ code: "NETWORK_ERROR", networkReason: "TLS" });
      return true;
    },
  );
}, 45000);

test("an HTTP client refusal does not prevent independent successful native Chromium analysis", async () => {
  const result = await diagnosePage(
    url("/hydrated"),
    async () => {
      throw new UpstreamHttpError(403, "private-url-token");
    },
    (value) => renderPublicSelectorPage(value, undefined, networkFactory),
  );
  expect(result.map((item) => item.success)).toEqual([false, true]);
  expect(result.map((item) => item.httpStatus)).toEqual([403, 200]);
  expect(result[1]?.label).toBe("Navigation Chromium native");
  expect(JSON.stringify(result)).not.toContain("private-url-token");
}, 45000);

test("article summaries use native rendered content when the initial HTTP client is refused", async () => {
  const service = new ArticleContentService(
    async (value) => {
      throw new UpstreamHttpError(403, value);
    },
    new ArticleBrowser(undefined, networkFactory),
  );
  const article = await service.fetchWithUrl(url("/hydrated"));
  expect(article.content).toContain("Contenu complet après chargement navigateur.");
  expect(article.url).toBe(url("/hydrated"));
}, 45000);

test("a refused RSS notice resolves its external document link through native Chromium without loading the journal", async () => {
  const start = requests.length;
  const service = new ArticleContentService(
    async (value) => {
      throw new UpstreamHttpError(403, value);
    },
    new ArticleBrowser(undefined, networkFactory),
  );
  expect(await service.resolveLink(url("/native-notice"), "a.primarydoc")).toBe(
    `http://ads.test:${port}/external-article`,
  );
  expect(requests.slice(start).some((item) => item.path === "/external-article")).toBe(false);
}, 45000);

test("article rendering cannot bypass an explicit HTTP rate limit", async () => {
  let browserCalled = false;
  const browser = new ArticleBrowser();
  browser.render = async () => {
    browserCalled = true;
    throw new Error();
  };
  const service = new ArticleContentService(async (value) => {
    throw new UpstreamHttpError(429, value);
  }, browser);
  await assert.rejects(service.fetchWithUrl(url("/hydrated")), {
    code: "UPSTREAM_ERROR",
    upstreamStatus: 429,
  });
  expect(browserCalled).toBe(false);
});

test("native navigation rejects embedded credentials before Chromium can send authorization", async () => {
  const start = requests.length;
  const credentialUrl = new URL(url("/hydrated"));
  credentialUrl.username = "private-user";
  credentialUrl.password = "private-password";
  const guarded: BrowserNetworkFactory = () =>
    BrowserNetwork.create(async (value) => {
      const target = new URL(value);
      if (target.username || target.password) return validateRemoteUrl(value);
      return { url: target, address: "127.0.0.1", family: 4 };
    });
  await assert.rejects(renderPublicSelectorPage(credentialUrl.href, undefined, guarded), {
    code: "UNSAFE_URL",
  });
  expect(requests.slice(start)).toHaveLength(0);
}, 45000);
