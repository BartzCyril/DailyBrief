import { afterAll, beforeAll, expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash, createPublicKey } from "node:crypto";
import { once } from "node:events";
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { BrowserNetwork, type BrowserNetworkFactory } from "../src/browser-network";
import { JournalLoginBrowser } from "../src/journal-login";
import { validateRemoteUrl, type FetchPage, type RemotePageOptions } from "../src/network";
import { nativeTlsFixture } from "./fixtures/native-tls";

const journalOrigin = "https://publisher.test";
const accountOrigin = "https://accounts.publisher.test";
const fullText = "Le contenu intégral accessible avec la session authentifiée native. ".repeat(18);
const credentials = {
  email: "native-reader@example.com",
  password: "native-journal-test-password",
  config: {
    loginUrl: `${accountOrigin}/login`,
    emailSelector: "#email",
    passwordSelector: "#password",
    submitSelector: "#submit",
    successSelector: null,
    articleContentSelector: ".full-body",
  },
};

type RecordedRequest = {
  path: string;
  method: string;
  protocol: string;
  host: string | undefined;
  cookie: string | undefined;
  subscriberHeader: string | undefined;
  origin: string | undefined;
  preflightMethod: string | undefined;
  preflightHeaders: string | undefined;
  body: string;
};
const requests: RecordedRequest[] = [];
const sockets = new Set<Socket>();
const tls = nativeTlsFixture();
const fixtureSpki = createHash("sha256")
  .update(createPublicKey(tls.key).export({ type: "spki", format: "der" }))
  .digest("base64");
const server = createSecureServer({ ...tls, allowHTTP1: true });

function respond(request: Http2ServerRequest, response: Http2ServerResponse, body: string) {
  const target = new URL(request.url!, journalOrigin);
  const path = target.pathname;
  const cookie = request.headers.cookie;
  const subscriberHeader = request.headers["x-subscriber-session"];
  const origin = request.headers.origin;
  const preflightMethod = request.headers["access-control-request-method"];
  const preflightHeaders = request.headers["access-control-request-headers"];
  requests.push({
    path,
    method: request.method!,
    protocol: request.httpVersion,
    host: (request.headers[":authority"] as string | undefined) ?? request.headers.host,
    cookie,
    subscriberHeader: typeof subscriberHeader === "string" ? subscriberHeader : undefined,
    origin: typeof origin === "string" ? origin : undefined,
    preflightMethod: typeof preflightMethod === "string" ? preflightMethod : undefined,
    preflightHeaders: typeof preflightHeaders === "string" ? preflightHeaders : undefined,
    body,
  });
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (path === "/login") {
    response.end(`<form method="POST" action="${accountOrigin}/authenticate">
      <input type="email" name="email" id="email">
      <input type="password" name="password" id="password">
      <button type="submit" id="submit">Connexion</button></form>${
        target.searchParams.get("ajax") === "reject"
          ? `<script>document.querySelector('form').addEventListener('submit',event=>{
              event.preventDefault();
              fetch('/authenticate-rejected', {
                method:'POST', body:new URLSearchParams(new FormData(event.target))
              }).catch(()=>{});
            });</script>`
          : ""
      }`);
    return;
  }
  if (path === "/authenticate-rejected") {
    response.writeHead(401).end("Connexion refusée. private-auth-token");
    return;
  }
  if (path === "/authenticate") {
    const fields = new URLSearchParams(body);
    if (
      fields.get("email") !== credentials.email ||
      fields.get("password") !== credentials.password
    ) {
      response.writeHead(401).end("Identifiants de test invalides");
      return;
    }
    response
      .writeHead(302, {
        Location: `${journalOrigin}/`,
        "Set-Cookie":
          "native-subscriber=fixture-session; Domain=publisher.test; Path=/; HttpOnly; Secure; SameSite=Lax",
      })
      .end();
    return;
  }
  if (path === "/_fs-ch-fixture/pat") {
    if (request.method !== "POST" || cookie || body) {
      response.writeHead(400).end("Invalid anonymous fixture check");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    setTimeout(() => response.end('{"verified":true}'), 150);
    return;
  }
  if (path === "/_fs-ch-fixture/assets/inter-var.woff2") {
    response.setHeader("Content-Type", "font/woff2");
    response.end("synthetic-font-response");
    return;
  }
  if (path === "/body") {
    response.setHeader("Access-Control-Allow-Origin", journalOrigin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Methods", "GET");
    response.setHeader("Access-Control-Allow-Headers", "x-subscriber-session");
    // The browser intentionally sends no cookies with a CORS preflight.
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
  }
  if (!cookie?.includes("native-subscriber=fixture-session")) {
    response.writeHead(401).end("La session de test est absente");
    return;
  }
  if (path === "/") {
    response.end(`<main><a href="/account">Mon compte</a></main><script>
      sessionStorage.setItem("subscriber-session", "native-tab-ready");
      window.name="native-authenticated-tab";
    </script>`);
    return;
  }
  // A site can reject an HTTP-client fingerprint while accepting Chromium's
  // genuine TLS/HTTP2 session. There is deliberately no retry or challenge bypass.
  if (path.startsWith("/article-") && request.httpVersion !== "2.0") {
    response
      .writeHead(402)
      .end('<main><form id="challenge-form">Automated requests blocked</form></main>');
    return;
  }
  if (path === "/article-challenge") {
    response.end("<title>Client Challenge</title><body></body>");
    return;
  }
  if (path === "/article-challenge-pat") {
    response.end(`<title>Client Challenge</title><body><article class="full-body"></article></body><script>
      new FontFace('ChallengeFixture', 'url(/_fs-ch-fixture/assets/inter-var.woff2)').load().catch(()=>{});
      fetch('/_fs-ch-fixture/pat?token=cookie-bearing',{method:'POST'}).catch(()=>{});
      fetch('/_fs-ch-fixture/pat?token=synthetic-page-generated-token',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'}})
        .then(r=>r.json()).then(data=>{if(data.verified){
          document.title='Article'; document.querySelector('article').innerText=${JSON.stringify(fullText)};
          fetch('/_fs-ch-fixture/pat?token=outside-challenge',{method:'POST',credentials:'omit'}).catch(()=>{});
          fetch('/mutate-after-challenge',{method:'POST',body:'must-not-send'}).catch(()=>{});
        }});
    </script>`);
    return;
  }
  if (path === "/article-bot") {
    response
      .writeHead(402)
      .end(
        '<main><h1>Access denied</h1><form id="challenge-form">Automated requests are blocked. Security check required.</form><p>private-challenge-token</p></main>',
      );
    return;
  }
  if (path === "/article-payment") {
    response
      .writeHead(402)
      .end(
        '<main><h1>Abonnement requis</h1><div class="paywall">Votre abonnement ne donne pas accès à cet article. Abonnez-vous pour lire la suite.</div><p>private-payment-token</p></main>',
      );
    return;
  }
  if (path === "/article-unknown") {
    response
      .writeHead(402)
      .end("<main>Une erreur temporaire est survenue. private-upstream-token</main>");
    return;
  }
  if (path === "/body") {
    if (subscriberHeader !== "native-tab-ready") {
      response.writeHead(403).end("Le stockage de cet onglet authentifié est absent");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ content: fullText }));
    return;
  }
  if (path === "/worker.js") {
    response.setHeader("Content-Type", "application/javascript");
    response.end("fetch('/mutate-worker',{method:'POST',body:'must-not-send'}).catch(()=>{});");
    return;
  }
  if (path === "/sw.js") {
    response.setHeader("Content-Type", "application/javascript");
    response.end(
      "self.addEventListener('install',event=>event.waitUntil(fetch('/mutate-sw',{method:'POST',body:'must-not-send'})));",
    );
    return;
  }
  if (path.startsWith("/mutate")) {
    response.end("Cette mutation ne doit jamais être atteinte");
    return;
  }
  if (path === "/article-cdn") {
    response.end(`<html><head><style>body{display:none}</style>
      <link rel="stylesheet" href="https://static.publisher.test/native-article.css">
      </head><body><article class="full-body"></article>
      <script src="https://static.publisher.test/native-article.js"></script></body></html>`);
    return;
  }
  if (["/article-full", "/article-workers", "/article-mutations"].includes(path)) {
    response.end(`<article class="full-body"></article><script>
      ${
        path !== "/article-full"
          ? `
        fetch('/mutate-fetch',{method:'POST',body:'must-not-send'}).catch(()=>{});
        try {
          ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker,'/sw.js').catch(()=>{});
        } catch {}
        try {
          const popup=window.open('about:blank');
          if(popup) {
            popup.document.write('<form method="POST" action="${journalOrigin}/mutate-popup"></form>');
            popup.document.forms[0].submit();
          }
        } catch {}
        try { new Worker('/worker.js'); } catch {}
        try {
          // Parser-created attributes inside a closed shadow tree cannot be
          // normalized by the document's event capture or MutationObserver.
          const host=document.createElement('div'); document.body.append(host);
          const shadow=host.attachShadow({mode:'closed'});
          shadow.innerHTML='<form method="POST" action="${journalOrigin}/mutate-shadow" target="_blank"><button type="submit">Envoyer</button></form>';
          shadow.querySelector('button').click();
        } catch {}
        ${
          path === "/article-mutations"
            ? `
        try {
          const form=document.createElement('form'); form.method='POST';
          form.action='/mutate-form'; form.target='_blank'; document.body.append(form); form.submit();
        } catch {}
        `
            : ""
        }
      `
          : ""
      }
      if(window.name==='native-authenticated-tab')
        fetch('${accountOrigin}/body',{
          credentials:'include',
          headers:{'X-Subscriber-Session':sessionStorage.getItem('subscriber-session')}
        })
          .then(r=>r.json()).then(data=>document.querySelector('article').innerText=data.content);
    </script>`);
    return;
  }
  response.writeHead(404).end("Page de test absente");
}

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.on("request", (request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });
  request.on("end", () => respond(request, response, body));
});
beforeAll(async () => {
  // Articles intentionally use the normal HTTPS port: the production journal
  // configuration rejects custom ports, and the relay never substitutes one.
  server.listen(443, "127.0.0.1");
  await once(server, "listening");
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const networkFactory =
  (trustFixture: boolean): BrowserNetworkFactory =>
  async () => {
    const network = await BrowserNetwork.create(async (value) => {
      const url = new URL(value);
      if (
        ["publisher.test", "accounts.publisher.test"].includes(url.hostname) &&
        (url.port || (url.protocol === "https:" ? "443" : "80")) === "443"
      )
        return { url, address: "127.0.0.1", family: 4 };
      // Fail closed for every other browser destination without resolving or
      // contacting any real host from this synthetic protocol fixture.
      return validateRemoteUrl("http://127.0.0.1/");
    });
    // Only this one generated loopback certificate is trusted for protocol tests.
    // The production factory keeps certificate validation fully enabled.
    if (trustFixture)
      network.launchOptions.args!.push(`--ignore-certificate-errors-spki-list=${fixtureSpki}`);
    return network;
  };
const nativeBrowser = (trustFixture = true) =>
  new JournalLoginBrowser(undefined, 5000, networkFactory(trustFixture));

test("a native HTTP 200 challenge performs only its anonymous PAT check and keeps subscriber access", async () => {
  const start = requests.length;
  await new JournalLoginBrowser(undefined, 5000, networkFactory(true), undefined, 1000).withSession(
    "publisher.test",
    credentials,
    async (read) => {
      expect((await read(`${journalOrigin}/article-challenge-pat`)).contentHtml).toContain(
        fullText,
      );
      await assert.rejects(read(`${journalOrigin}/article-challenge`), (error: unknown) => {
        expect(error).toMatchObject({ code: "JOURNAL_ARTICLE_BROWSER_CHALLENGE" });
        expect(String(error)).not.toContain("synthetic-page-generated-token");
        return true;
      });
      expect((await read(`${journalOrigin}/article-full`)).contentHtml).toContain(fullText);
    },
  );
  const sent = requests.slice(start);
  const pat = sent.filter((request) => request.path === "/_fs-ch-fixture/pat");
  expect(pat).toHaveLength(1);
  expect(pat[0]).toMatchObject({ method: "POST", body: "", protocol: "2.0" });
  expect(pat[0]?.cookie).toBeUndefined();
  expect(sent.some((request) => request.path === "/_fs-ch-fixture/assets/inter-var.woff2")).toBe(
    true,
  );
  expect(sent.some((request) => request.path === "/mutate-after-challenge")).toBe(false);
  expect(
    sent.filter((request) => request.method === "POST").map((request) => request.path),
  ).toEqual(["/authenticate", "/_fs-ch-fixture/pat"]);
}, 45000);

test("journal authentication and article hydration use native Chromium HTTP/2 with cookies and the same tab storage", async () => {
  const refused = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: "publisher.test",
        path: "/article-full",
        method: "GET",
        rejectUnauthorized: false,
        headers: { Host: "publisher.test", Cookie: "native-subscriber=fixture-session" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
  expect(refused).toBe(402);
  const start = requests.length;
  const progress: string[] = [];
  const page = await nativeBrowser().run(
    "publisher.test",
    credentials,
    `${journalOrigin}/article-full`,
    (message) => progress.push(message),
  );
  expect(page.contentHtml).toContain(fullText);
  expect(page.url).toBe(`${journalOrigin}/article-full`);
  const sent = requests.slice(start);
  expect(sent.every((request) => request.protocol === "2.0")).toBe(true);
  expect(
    sent.filter((request) => request.method === "POST").map((request) => request.path),
  ).toEqual(["/authenticate"]);
  expect(sent.find((request) => request.path === "/login")?.cookie).toBeUndefined();
  expect(sent.find((request) => request.path === "/authenticate")?.host).toBe(
    "accounts.publisher.test",
  );
  const contentRequests = sent.filter((request) => request.path === "/body");
  expect(contentRequests.map((request) => request.method)).toEqual(["OPTIONS", "GET"]);
  expect(contentRequests[0]).toMatchObject({
    host: "accounts.publisher.test",
    origin: journalOrigin,
    preflightMethod: "GET",
    preflightHeaders: "x-subscriber-session",
  });
  expect(contentRequests[0]?.cookie).toBeUndefined();
  expect(contentRequests[1]).toMatchObject({
    host: "accounts.publisher.test",
    origin: journalOrigin,
    cookie: "native-subscriber=fixture-session",
    subscriberHeader: "native-tab-ready",
  });
  expect(progress).toContain("Connexion acceptée après redirection vers l'accueil du journal.");
  for (const secret of [
    credentials.email,
    credentials.password,
    "fixture-session",
    "native-tab-ready",
  ])
    expect(progress.join("\n")).not.toContain(secret);
}, 45000);

test.each([
  ["bot", "JOURNAL_ARTICLE_AUTOMATION_BLOCKED"],
  ["payment", "JOURNAL_ARTICLE_SUBSCRIPTION_REQUIRED"],
  ["unknown", "JOURNAL_ARTICLE_HTTP_ERROR"],
])(
  "an actual native HTTP 402 %s response reports its reason without returning the upstream body",
  async (kind, code) => {
    await assert.rejects(
      nativeBrowser().run("publisher.test", credentials, `${journalOrigin}/article-${kind}`),
      (error: unknown) => {
        expect(error).toMatchObject({ code });
        expect(String(error)).not.toContain("private-");
        expect(String(error)).not.toContain(credentials.password);
        return true;
      },
    );
  },
  45000,
);

test("native article hydration remains read-only across fetch, target-blank forms, popups, workers and service workers", async () => {
  const start = requests.length;
  await nativeBrowser().withSession("publisher.test", credentials, async (read) => {
    // Test worker registration separately so an aborted form navigation cannot
    // hide an auxiliary worker request that bypasses tab interception.
    expect((await read(`${journalOrigin}/article-workers`)).contentHtml).toContain(fullText);
    // A POST form attempting to navigate the main document is a hard failure,
    // while the retained authenticated tab remains usable for the next read.
    await assert.rejects(read(`${journalOrigin}/article-mutations`), {
      code: "JOURNAL_LOGIN_REQUEST_BLOCKED",
    });
    expect((await read(`${journalOrigin}/article-full`)).contentHtml).toContain(fullText);
  });
  const sent = requests.slice(start);
  expect(
    sent.filter((request) => request.method === "POST").map((request) => request.path),
  ).toEqual(["/authenticate"]);
  expect(sent.some((request) => request.path.startsWith("/mutate"))).toBe(false);
  expect(sent.some((request) => request.path === "/worker.js")).toBe(false);
  expect(sent.some((request) => request.path === "/sw.js")).toBe(false);
  expect(sent.some((request) => request.path === "/body")).toBe(true);
}, 45000);

test("native journal access keeps production certificate verification enabled", async () => {
  const start = requests.length;
  await assert.rejects(nativeBrowser(false).run("publisher.test", credentials), {
    code: "JOURNAL_LOGIN_NETWORK_TLS",
  });
  expect(requests.slice(start)).toHaveLength(0);
}, 45000);

test("a rejected native AJAX login reports the authentication failure when no homepage or session is confirmed", async () => {
  const start = requests.length;
  const browser = new JournalLoginBrowser(undefined, 1500, networkFactory(true));
  const login = {
    ...credentials,
    config: { ...credentials.config, loginUrl: `${accountOrigin}/login?ajax=reject` },
  };
  await assert.rejects(
    browser.run("publisher.test", login, `${journalOrigin}/article-full`),
    (error: unknown) => {
      expect(error).toMatchObject({ code: "JOURNAL_LOGIN_FAILED" });
      expect(String(error)).not.toContain("private-auth-token");
      expect(String(error)).not.toContain(credentials.password);
      return true;
    },
  );
  const sent = requests.slice(start);
  expect(
    sent.filter((request) => request.method === "POST").map((request) => request.path),
  ).toEqual(["/authenticate-rejected"]);
  expect(sent.some((request) => request.path.startsWith("/article-"))).toBe(false);
}, 45000);

test("public CDN JavaScript and CSS hydrate the authenticated article without sharing or replacing session cookies", async () => {
  const start = requests.length;
  const assets: { url: string; options?: RemotePageOptions }[] = [];
  const fetchAsset: FetchPage = async (url, options) => {
    assets.push({ url, options });
    const target = new URL(url);
    assert.equal(target.origin, "https://static.publisher.test");
    expect(options?.method ?? "GET").toBe("GET");
    expect(options?.cookie).toBeUndefined();
    expect(options?.applicationHeaders).toBeUndefined();
    expect(options?.browserHeaders).toBeUndefined();
    expect(options?.body).toBeUndefined();
    expect(options?.requestedWith).toBeUndefined();
    expect(options?.referer === undefined || options.referer === `${journalOrigin}/`).toBe(true);
    const css = target.pathname === "/native-article.css";
    assert(css || target.pathname === "/native-article.js");
    return {
      url,
      status: 200,
      contentType: css ? "text/css" : "application/javascript",
      // A public asset response must not be able to replace the subscriber's
      // parent-domain cookie, even when its CDN shares that parent domain.
      cookies: [
        "native-subscriber=cdn-forged-session; Domain=publisher.test; Path=/; HttpOnly; Secure; SameSite=Lax",
      ],
      text: css
        ? "body{display:block !important}"
        : `
        fetch('${accountOrigin}/body',{
          credentials:'include',
          headers:{'X-Subscriber-Session':sessionStorage.getItem('subscriber-session')}
        }).then(r=>r.json()).then(data=>document.querySelector('article').innerText=data.content);
      `,
    };
  };
  const browser = new JournalLoginBrowser(undefined, 5000, networkFactory(true), fetchAsset);
  await browser.withSession("publisher.test", credentials, async (read) => {
    expect(
      (await read(`${journalOrigin}/article-cdn?private=fixture-article-token`)).contentHtml,
    ).toContain(fullText);
    expect((await read(`${journalOrigin}/article-full`)).contentHtml).toContain(fullText);
  });
  expect(assets.map((asset) => new URL(asset.url).pathname).sort()).toEqual([
    "/native-article.css",
    "/native-article.js",
  ]);
  const sent = requests.slice(start);
  const contentRequests = sent.filter(
    (request) => request.path === "/body" && request.method === "GET",
  );
  expect(contentRequests).toHaveLength(2);
  expect(
    contentRequests.every((request) => request.cookie === "native-subscriber=fixture-session"),
  ).toBe(true);
  expect(contentRequests.every((request) => request.subscriberHeader === "native-tab-ready")).toBe(
    true,
  );
  expect(sent.every((request) => request.host !== "static.publisher.test")).toBe(true);
  expect(
    sent.filter((request) => request.method === "POST").map((request) => request.path),
  ).toEqual(["/authenticate"]);
}, 45000);
