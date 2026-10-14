import { expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { JournalLoginBrowser } from "../src/journal-login";
import type { FetchPage } from "../src/network";
import { fullText, journalFixture, loginConfig } from "./fixtures/journal-login";
import { journalPatRequestAllowed } from "../src/journal-verification";

const credentials = {
  email: "reader@example.com",
  password: "journal-test-password",
  config: loginConfig,
};
const articleHtml = `<article class="full-body"><p>${fullText}</p></article>`;

test("a persistent HTTP 200 Client Challenge reports verification rather than a blank-content timeout and keeps the session usable", async () => {
  const fixture = journalFixture();
  const observations: string[] = [];
  const fetch: FetchPage = async (url, options) => {
    const response = await fixture.fetch(url, options);
    if (new URL(url).pathname === "/article-challenge")
      return {
        ...response,
        text: `<title>Client Challenge</title><script>
        fetch('/browser-check', {method:'POST',body:'private-validation-token'}).catch(()=>{});
      </script><body></body>`,
      };
    return response;
  };
  await new JournalLoginBrowser(fetch, 800, undefined, undefined, 300).withSession(
    "publisher.example",
    credentials,
    async (read) => {
      await assert.rejects(
        read("https://publisher.example/article-challenge?token=private-query-token", (message) =>
          observations.push(message),
        ),
        (error: unknown) => {
          expect(error).toMatchObject({ code: "JOURNAL_ARTICLE_BROWSER_CHALLENGE" });
          expect(String(error)).toContain("Client challenge");
          expect(String(error)).toContain("AJAX bloquées par le projet : 1");
          const disclosed = JSON.stringify({ error, message: String(error), observations });
          for (const secret of [
            credentials.email,
            credentials.password,
            "private-validation-token",
            "private-query-token",
            "own-session",
          ])
            expect(disclosed).not.toContain(secret);
          return true;
        },
      );
      expect((await read("https://publisher.example/article")).contentHtml).toContain(fullText);
    },
  );
  expect(
    fixture.requests.some((request) => new URL(request.url).pathname === "/browser-check"),
  ).toBe(false);
  expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(1);
  expect(observations.some((message) => message.includes("Client challenge"))).toBe(true);
}, 15000);

test("a transient Client Challenge can clear naturally in the same authenticated tab before article extraction", async () => {
  const fixture = journalFixture();
  const observations: string[] = [];
  const fetch: FetchPage = async (url, options) => {
    const response = await fixture.fetch(url, options);
    if (new URL(url).pathname === "/article-transient")
      if (options?.cookie?.includes("verification=completed"))
        return { ...response, text: `<title>Article</title>${articleHtml}` };
      else
        return {
          ...response,
          text: `<title>Client Challenge</title><body></body><script>setTimeout(()=>{
        document.cookie='verification=completed;Path=/;Secure';
        location.reload();
      },1800)</script>`,
        };
    return response;
  };
  await new JournalLoginBrowser(fetch, 800, undefined, undefined, 3000).withSession(
    "publisher.example",
    credentials,
    async (read) => {
      expect(
        (
          await read("https://publisher.example/article-transient", (message) =>
            observations.push(message),
          )
        ).contentHtml,
      ).toContain(fullText);
      expect((await read("https://publisher.example/article")).contentHtml).toContain(fullText);
    },
  );
  expect(
    fixture.requests.find((request) => request.url.endsWith("/article"))?.options?.cookie,
  ).toContain("verification=completed");
  expect(observations.some((message) => message.includes("Client challenge"))).toBe(true);
  expect(observations.some((message) => message.includes("contrôle a disparu"))).toBe(true);
}, 15000);

test("a challenge replacing the rendered article cannot be extracted as subscriber content", async () => {
  const fixture = journalFixture();
  const fetch: FetchPage = async (url, options) => {
    const response = await fixture.fetch(url, options);
    if (new URL(url).pathname === "/article-replaced")
      return {
        ...response,
        text: `<title>Article</title>${articleHtml}<script>setTimeout(()=>{document.title='Client Challenge';document.body.innerHTML='';},900)</script>`,
      };
    return response;
  };
  await expect(
    new JournalLoginBrowser(fetch, 1500, undefined, undefined, 200).run(
      "publisher.example",
      credentials,
      "https://publisher.example/article-replaced",
    ),
  ).rejects.toMatchObject({ code: "JOURNAL_ARTICLE_BROWSER_CHALLENGE" });
}, 10000);

test("recognizes a Client Challenge that appears after initial navigation", async () => {
  const fixture = journalFixture();
  const fetch: FetchPage = async (url, options) => {
    const response = await fixture.fetch(url, options);
    if (new URL(url).pathname === "/article-late")
      return {
        ...response,
        text: `<title>Chargement</title><body></body><script>setTimeout(()=>document.title='Client Challenge',900)</script>`,
      };
    return response;
  };
  await expect(
    new JournalLoginBrowser(fetch, 1000, undefined, undefined, 200).run(
      "publisher.example",
      credentials,
      "https://publisher.example/article-late",
    ),
  ).rejects.toMatchObject({ code: "JOURNAL_ARTICLE_BROWSER_CHALLENGE" });
}, 10000);

test("does not mistake a real article about Client Challenge for a verification page", async () => {
  const fixture = journalFixture();
  const fetch: FetchPage = async (url, options) => {
    const response = await fixture.fetch(url, options);
    if (new URL(url).pathname === "/article-topic")
      return {
        ...response,
        text: `<title>Client Challenge</title>${articleHtml}<script>fetch('/_fs-ch-fixture/pat?token=synthetic',{method:'POST',credentials:'omit'}).catch(()=>{});</script>`,
      };
    return response;
  };
  expect(
    (
      await new JournalLoginBrowser(fetch, 2000, undefined, undefined, 0).run(
        "publisher.example",
        credentials,
        "https://publisher.example/article-topic",
      )
    ).contentHtml,
  ).toContain(fullText);
  expect(fixture.requests.some((request) => new URL(request.url).pathname.endsWith("/pat"))).toBe(
    false,
  );
}, 10000);

test("allows only the site's empty credential-free PAT request during its Client Challenge", async () => {
  const fixture = journalFixture();
  const fetch: FetchPage = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/_fs-ch-fixture/pat") {
      fixture.requests.push({ url, options });
      return {
        status: 200,
        cookies: [],
        contentType: "application/json",
        text: '{"verified":true}',
      };
    }
    const response = await fixture.fetch(url, options);
    if (path === "/article-pat")
      return {
        ...response,
        text: `<title>Client Challenge</title><body></body><script>
        fetch('/_fs-ch-fixture/pat?token=synthetic-page-token', {method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'}})
          .then(r=>r.json()).then(data=>{if(data.verified){document.title='Article';document.body.innerHTML=${JSON.stringify(articleHtml)};}});
      </script>`,
      };
    return response;
  };
  const page = await new JournalLoginBrowser(fetch, 1200, undefined, undefined, 3000).run(
    "publisher.example",
    credentials,
    "https://publisher.example/article-pat",
  );
  expect(page.contentHtml).toContain(fullText);
  const pat = fixture.requests.find((request) => new URL(request.url).pathname.endsWith("/pat"));
  expect(pat?.options).toMatchObject({ method: "POST", body: "" });
  expect(pat?.options?.cookie).toBeUndefined();
  expect(pat?.options?.browserHeaders?.cookie).toBeUndefined();
  expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(2);
}, 15000);

test("the PAT exception rejects credential-bearing, body-bearing or unrelated requests", () => {
  const request = {
    url: "https://publisher.example/_fs-ch-fixture/pat?token=synthetic",
    method: "POST",
    resourceType: "fetch",
    headers: {},
    body: "",
    hasPostData: false,
  };
  expect(journalPatRequestAllowed(request, "https://publisher.example")).toBe(true);
  const changes: Partial<Parameters<typeof journalPatRequestAllowed>[0]>[] = [
    { body: "credentials-or-mutation" },
    { body: "", hasPostData: true },
    { headers: { cookie: "sid=synthetic" } },
    { headers: { Authorization: "Bearer synthetic" } },
    { headers: { "Proxy-Authorization": "Basic synthetic" } },
    { method: "GET" },
    { resourceType: "document" },
    { url: "https://other.example/_fs-ch-fixture/pat?token=synthetic" },
    { url: "https://secure.publisher.example/_fs-ch-fixture/pat?token=synthetic" },
    { url: "http://publisher.example/_fs-ch-fixture/pat?token=synthetic" },
    { url: "https://publisher.example/account/delete?token=synthetic" },
    { url: "https://publisher.example/_fs-ch-fixture/pat?token=synthetic&redirect=other" },
    { url: "https://publisher.example/_fs-ch-fixture/pat?token=" },
    { url: `https://publisher.example/_fs-ch-fixture/pat?token=${"x".repeat(8193)}` },
  ];
  for (const change of changes)
    expect(journalPatRequestAllowed({ ...request, ...change }, "https://publisher.example")).toBe(
      false,
    );
});
