import { strict as assert } from "node:assert";
import { expect, test } from "bun:test";
import { JournalLoginBrowser } from "../src/journal-login";
import type { FetchPage, RemotePageOptions } from "../src/network";
import { fullText, journalFixture, loginConfig } from "./fixtures/journal-login";

const journalOrigin = "https://publisher.example";
const assetOrigin = "https://static.publisher-cdn.example";
const credentials = {
  email: "reader@example.com",
  password: "journal-test-password",
  config: loginConfig,
};
type AssetRequest = { url: string; options?: RemotePageOptions };

function expectAnonymous(request: AssetRequest) {
  expect(new URL(request.url).protocol).toBe("https:");
  expect(request.options?.method).toBe("GET");
  for (const field of [
    "body",
    "cookie",
    "referer",
    "requestedWith",
    "applicationHeaders",
    "browserHeaders",
  ] as const)
    expect(request.options?.[field]).toBeUndefined();
  for (const secret of [credentials.email, credentials.password, "own-session"])
    expect(JSON.stringify(request)).not.toContain(secret);
}

function expectSafeError(error: unknown, observations: string[] = []) {
  expect(error).toMatchObject({ code: "JOURNAL_ARTICLE_CONTENT_TIMEOUT" });
  const message = String(error);
  for (const secret of [
    credentials.email,
    credentials.password,
    "own-session",
    "private-diagnostic-query",
    "private-asset-error-body",
    assetOrigin,
  ])
    expect(JSON.stringify({ message, observations })).not.toContain(secret);
  return message;
}

test("authenticated articles render public CDN scripts and CSS anonymously without changing the subscriber cookies", async () => {
  const fixture = journalFixture();
  const assets: AssetRequest[] = [];
  const fetch: FetchPage = async (url, options) => {
    const target = new URL(url);
    if (target.origin === assetOrigin) {
      assets.push({ url, options });
      return {
        status: 200,
        cookies: ["sid=cdn-injected-session; Domain=publisher.example; Path=/; HttpOnly; Secure"],
        contentType: target.pathname.endsWith(".css") ? "text/css" : "application/javascript",
        text: target.pathname.endsWith(".css")
          ? "body { display: block !important; }"
          : `document.querySelector('article').innerText=${JSON.stringify(fullText)};`,
      };
    }
    const response = await fixture.fetch(url, options);
    if (target.pathname === "/article-cdn")
      return {
        ...response,
        text: `<html><head><style>body{display:none}</style>
          <link rel="stylesheet" href="${assetOrigin}/article.css?v=4">
          </head><body><article class="full-body"></article>
          <script src="${assetOrigin}/article.js?v=4"></script></body></html>`,
      };
    return response;
  };
  await new JournalLoginBrowser(fetch, 3000).withSession(
    "publisher.example",
    credentials,
    async (read) => {
      expect((await read(`${journalOrigin}/article-cdn`)).contentHtml).toContain(fullText);
      expect((await read(`${journalOrigin}/article`)).contentHtml).toContain(fullText);
    },
  );
  expect(assets.map(({ url }) => new URL(url).pathname).sort()).toEqual([
    "/article.css",
    "/article.js",
  ]);
  assets.forEach(expectAnonymous);
  expect(
    fixture.requests.find(({ url }) => url === `${journalOrigin}/article`)?.options?.cookie,
  ).toBe("sid=own-session");
}, 20000);

test("anonymous public module assets preserve browser CORS through a CDN redirect and imported chunk", async () => {
  const fixture = journalFixture();
  const assets: AssetRequest[] = [];
  const redirectedOrigin = "https://bundles.publisher-cdn.example";
  const fetch: FetchPage = async (url, options) => {
    const target = new URL(url);
    if ([assetOrigin, redirectedOrigin].includes(target.origin)) {
      assets.push({ url, options });
      const corsHeaders = { "access-control-allow-origin": options?.origin ?? journalOrigin };
      if (target.pathname === "/entry.js")
        return {
          status: 302,
          cookies: [],
          text: "",
          location: `${redirectedOrigin}/render.js`,
          corsHeaders,
        };
      return {
        status: 200,
        cookies: [],
        contentType: "application/javascript",
        corsHeaders,
        text:
          target.pathname === "/render.js"
            ? `import {content} from './chunk.js'; document.querySelector('article').innerText=content;`
            : `export const content=${JSON.stringify(fullText)};`,
      };
    }
    const response = await fixture.fetch(url, options);
    if (target.pathname === "/article-module")
      return {
        ...response,
        text: `<article class="full-body"></article><script type="module" src="${assetOrigin}/entry.js"></script>`,
      };
    return response;
  };
  const article = await new JournalLoginBrowser(fetch, 3000).run(
    "publisher.example",
    credentials,
    `${journalOrigin}/article-module`,
  );
  expect(article.contentHtml).toContain(fullText);
  expect(assets.map(({ url }) => new URL(url).pathname)).toEqual([
    "/entry.js",
    "/render.js",
    "/chunk.js",
  ]);
  expect(assets[0]?.options?.origin).toBe(journalOrigin);
  expect(assets[1]?.options?.origin).toBe("null");
  expect(assets[2]?.options?.origin).toBe(journalOrigin);
  assets.forEach(expectAnonymous);
}, 15000);

test("public asset exceptions keep credential URLs, sensitive query parameters and third-party API traffic blocked", async () => {
  const fixture = journalFixture();
  const assets: AssetRequest[] = [];
  const blockedPaths = [
    `/email/${encodeURIComponent(credentials.email)}.js`,
    `/email/${encodeURIComponent(encodeURIComponent(credentials.email))}.js`,
    `/email/${encodeURIComponent(encodeURIComponent(encodeURIComponent(credentials.email)))}.js`,
    `/password/%6Aournal-test-password.js`,
    `/password/%256Aournal-test-password.js`,
    `/password/%25256Aournal-test-password.js`,
    "/session.js?session=private-query-value",
    "/token.js?token=private-query-value",
    "/auth.js?auth=private-query-value",
    "/jwt.js?jwt=private-query-value",
    "/encoded-key.js?%73ession=private-query-value",
    "/encoded-token-key.js?%2574oken=unknown-private-value",
    "/encoded-session-key.js?%2573ession=unknown-private-value",
    "/deeply-encoded/%25252525252561sset.js",
  ];
  const fetch: FetchPage = async (url, options) => {
    const target = new URL(url);
    if (target.origin === assetOrigin) {
      assets.push({ url, options });
      return { status: 200, cookies: [], text: "", contentType: "application/javascript" };
    }
    const response = await fixture.fetch(url, options);
    if (target.pathname === "/article-protected")
      return {
        ...response,
        text: `${response.text}
          ${blockedPaths.map((path) => `<script src="${assetOrigin}${path}"></script>`).join("")}
          <script src="${assetOrigin}/public.js?v=4"></script>
          <script>
            fetch('${assetOrigin}/api-read').catch(()=>{});
            fetch('${assetOrigin}/api-write',{method:'POST',body:'must-not-send'}).catch(()=>{});
          </script>`,
      };
    return response;
  };
  const article = await new JournalLoginBrowser(fetch, 3000).run(
    "publisher.example",
    credentials,
    `${journalOrigin}/article-protected`,
  );
  expect(article.contentHtml).toContain(fullText);
  expect(assets.map(({ url }) => url)).toEqual([`${assetOrigin}/public.js?v=4`]);
  assets.forEach(expectAnonymous);
}, 15000);

test("an empty HTTP 200 article reports a safe blank-document diagnostic", async () => {
  const fixture = journalFixture();
  const observations: string[] = [];
  const fetch: FetchPage = async (url, options) => {
    if (new URL(url).pathname === "/article-blank")
      return {
        status: 200,
        cookies: [],
        contentType: "text/html",
        text: "<html><head></head><body></body></html>",
      };
    return fixture.fetch(url, options);
  };
  await assert.rejects(
    new JournalLoginBrowser(fetch, 800).run(
      "publisher.example",
      credentials,
      `${journalOrigin}/article-blank?private=private-diagnostic-query`,
      (message) => observations.push(message),
    ),
    (error: unknown) => {
      const message = expectSafeError(error, observations);
      expect(message).toContain("HTTP 200");
      expect(message).toContain("0 caractère");
      return true;
    },
  );
}, 10000);

test("a page-controlled text counter cannot leak into the article rendering diagnostic", async () => {
  const fixture = journalFixture();
  const observations: string[] = [];
  const pageControlledValue = "private-page-controlled-counter";
  const fetch: FetchPage = async (url, options) => {
    if (new URL(url).pathname === "/article-controlled-counter")
      return {
        status: 200,
        cookies: [],
        contentType: "text/html",
        text: `<html><body><script>
          Object.defineProperty(document.body,'innerText',{
            get:()=>({trim:()=>({length:${JSON.stringify(pageControlledValue)}})})
          });
        </script></body></html>`,
      };
    return fixture.fetch(url, options);
  };
  await assert.rejects(
    new JournalLoginBrowser(fetch, 800).run(
      "publisher.example",
      credentials,
      `${journalOrigin}/article-controlled-counter`,
      (message) => observations.push(message),
    ),
    (error: unknown) => {
      const message = expectSafeError(error, observations);
      expect(message).toContain("HTTP 200");
      expect(message).toContain("texte visible : indéterminé");
      expect(JSON.stringify({ message, observations })).not.toContain(pageControlledValue);
      return true;
    },
  );
}, 10000);

test("missing public scripts and CSS report safe rendering failure counts rather than upstream bodies", async () => {
  const fixture = journalFixture();
  const observations: string[] = [];
  const assets: AssetRequest[] = [];
  const fetch: FetchPage = async (url, options) => {
    const target = new URL(url);
    if (target.origin === assetOrigin) {
      assets.push({ url, options });
      return {
        status: 404,
        cookies: [],
        contentType: "text/plain",
        text: "private-asset-error-body",
      };
    }
    const response = await fixture.fetch(url, options);
    if (target.pathname === "/article-missing-assets")
      return {
        ...response,
        text: `<html><head><link rel="stylesheet" href="${assetOrigin}/missing.css"></head>
          <body><article class="full-body"></article>
          <script src="${assetOrigin}/missing.js"></script></body></html>`,
      };
    return response;
  };
  await assert.rejects(
    new JournalLoginBrowser(fetch, 800).run(
      "publisher.example",
      credentials,
      `${journalOrigin}/article-missing-assets`,
      (message) => observations.push(message),
    ),
    (error: unknown) => {
      const message = expectSafeError(error, observations);
      expect(message).toContain("HTTP 200");
      expect(message).toContain("scripts en échec : 1");
      expect(message).toContain("feuilles de style en échec : 1");
      return true;
    },
  );
  expect(assets).toHaveLength(2);
  assets.forEach(expectAnonymous);
}, 10000);
