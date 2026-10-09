import { strict as assert } from "node:assert";
import { test, expect } from "bun:test";
import { JournalLoginBrowser } from "../src/journal-login";
import { journalFixture, loginConfig, fullText } from "./fixtures/journal-login";

const credentials = {
  email: "reader@example.com",
  password: "journal-test-password",
  config: loginConfig,
};

test("posts the configured form and reads the article in the same fresh authenticated context", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(fixture.fetch);
  const messages: string[] = [];
  const result = await browser.run(
    "publisher.example",
    credentials,
    "http://publisher.example/article",
    (message) => messages.push(message),
  );
  expect(result.url).toBe("https://publisher.example/article");
  expect(result.contentHtml).toContain(fullText);
  expect(
    fixture.requests.find((request) => request.url.endsWith("/article"))?.options?.cookie,
  ).toContain("sid=own-session");
  const post = fixture.requests.find((request) => request.options?.method === "POST");
  expect(post?.url).toBe("https://publisher.example/authenticate");
  expect(new URLSearchParams(post?.options?.body).get("password")).toBe(credentials.password);
  expect(messages.join(" ")).not.toContain(credentials.password);
  expect(messages.join(" ")).not.toContain(credentials.email);
  expect(messages.join(" ")).not.toContain("own-session");
}, 45000);

test("isolates cookies between users and drops them after a connection test", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(fixture.fetch);
  await browser.run("publisher.example", credentials);
  await browser.run(
    "publisher.example",
    { ...credentials, email: "other@example.com" },
    "https://publisher.example/article",
  );
  await browser.run("publisher.example", credentials, "https://publisher.example/article");
  const initialVisits = fixture.requests.filter((request) => request.url.endsWith("/login"));
  expect(initialVisits).toHaveLength(3);
  expect(initialVisits.every((request) => !request.options?.cookie)).toBe(true);
  expect(
    fixture.requests
      .filter((request) => request.url.endsWith("/article"))
      .map((request) => request.options?.cookie),
  ).toEqual(["sid=other-session", "sid=own-session"]);
}, 60000);

test("uses an explicitly configured separate login origin without forwarding its cookies to the journal", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) => {
    if (new URL(url).pathname === "/authenticate") {
      fixture.requests.push({ url, options });
      return {
        status: 303,
        cookies: ["sso=private-session; Path=/; HttpOnly; Secure"],
        location: "https://publisher.example/callback",
        text: "",
      };
    }
    if (url === "https://publisher.example/callback") {
      expect(options?.cookie).toBeUndefined();
      return {
        status: 200,
        cookies: ["sid=own-session; Path=/; HttpOnly; Secure"],
        text: '<div id="account">Mon compte</div>',
        contentType: "text/html",
      };
    }
    return fixture.fetch(url, options);
  });
  const result = await browser.run(
    "publisher.example",
    { ...credentials, config: { ...loginConfig, loginUrl: "https://accounts.example/login" } },
    "https://publisher.example/article",
  );
  expect(result.contentHtml).toContain(fullText);
  expect(fixture.requests.find((request) => request.options?.method === "POST")?.url).toBe(
    "https://accounts.example/authenticate",
  );
  expect(
    fixture.requests.find((request) => request.url.endsWith("/article"))?.options?.cookie,
  ).toBe("sid=own-session");
}, 45000);

test("blocks third-party traffic and mutations once the article uses the authenticated session", async () => {
  const fixture = journalFixture();
  fixture.state.malicious = true;
  const result = await new JournalLoginBrowser(fixture.fetch).run(
    "publisher.example",
    credentials,
    "https://publisher.example/article",
  );
  expect(result.contentHtml).toContain(fullText);
  expect(
    fixture.requests.some(
      (request) => request.url.includes("attacker.example") || request.url.endsWith("/mutation"),
    ),
  ).toBe(false);
}, 45000);

test("wrong credentials and selector errors cannot expose passwords or transport errors", async () => {
  const fixture = journalFixture();
  fixture.state.failed = true;
  const browser = new JournalLoginBrowser(fixture.fetch, 700);
  try {
    await browser.run("publisher.example", credentials);
    throw new Error("Must reject");
  } catch (error) {
    expect(error).toMatchObject({ code: "JOURNAL_LOGIN_FAILED" });
    expect((error as Error).message).not.toContain(credentials.password);
    expect((error as Error).message).not.toContain("email=");
  }
  await assert.rejects(
    browser.run("publisher.example", {
      ...credentials,
      config: { ...loginConfig, emailSelector: "#missing" },
    }),
    { code: "JOURNAL_LOGIN_FAILED" },
  );
  await assert.rejects(
    new JournalLoginBrowser(async () => {
      throw new Error(`password=${credentials.password}`);
    }, 700).run("publisher.example", credentials),
    { code: "JOURNAL_LOGIN_FAILED" },
  );
}, 45000);

test("rejects a success marker already visible before login and forms that submit secrets through GET", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(fixture.fetch);
  await assert.rejects(
    browser.run("publisher.example", {
      ...credentials,
      config: { ...loginConfig, successSelector: "body" },
    }),
    { code: "JOURNAL_LOGIN_SUCCESS_SELECTOR_INVALID" },
  );
  fixture.state.getForm = true;
  await assert.rejects(browser.run("publisher.example", credentials), {
    code: "JOURNAL_LOGIN_INSECURE_FORM",
  });
  expect(
    fixture.requests.some((request) => request.options?.body?.includes(credentials.password)),
  ).toBe(false);
}, 45000);

test("blocks undeclared POST destinations and redirects before delivering credentials or cookies", async () => {
  const fixture = journalFixture();
  fixture.state.foreignPost = true;
  const browser = new JournalLoginBrowser(fixture.fetch);
  await assert.rejects(browser.run("publisher.example", credentials), {
    code: "JOURNAL_LOGIN_REDIRECT_BLOCKED",
  });
  expect(fixture.requests.some((request) => request.url.includes("attacker.example"))).toBe(false);
  fixture.state.foreignPost = false;
  fixture.state.foreignRedirect = true;
  await assert.rejects(browser.run("publisher.example", credentials), {
    code: "JOURNAL_LOGIN_REDIRECT_BLOCKED",
  });
  expect(fixture.requests.some((request) => request.url.includes("attacker.example"))).toBe(false);
}, 45000);

test("expired sessions and remaining subscription walls never yield an article", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(fixture.fetch);
  fixture.state.expired = true;
  await assert.rejects(
    browser.run("publisher.example", credentials, "https://publisher.example/article"),
    { code: "JOURNAL_SESSION_EXPIRED" },
  );
  fixture.state.expired = false;
  fixture.state.paywall = true;
  await assert.rejects(
    browser.run("publisher.example", credentials, "https://publisher.example/article"),
    { code: "JOURNAL_ARTICLE_ACCESS_DENIED" },
  );
}, 45000);

test("refuses another journal target and private destinations through the protected transport", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(fixture.fetch, 700);
  await assert.rejects(
    browser.run("publisher.example", credentials, "https://other.example/article"),
    { code: "JOURNAL_UNSAFE_TARGET" },
  );
  expect(fixture.requests).toHaveLength(0);
  await assert.rejects(
    new JournalLoginBrowser(undefined, 700).run("publisher.example", {
      ...credentials,
      config: { ...loginConfig, loginUrl: "https://127.0.0.1/private" },
    }),
    { code: "JOURNAL_LOGIN_FAILED" },
  );
}, 45000);
