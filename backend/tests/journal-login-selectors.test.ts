import { strict as assert } from "node:assert";
import { test, expect } from "bun:test";
import { createScrapingPage, launchScrapingBrowser } from "../src/browser";
import { JournalLoginBrowser } from "../src/journal-login";
import { visibleJournalSelector } from "../src/journal-login-selectors";
import { journalFixture, loginConfig, fullText } from "./fixtures/journal-login";

const credentials = {
  email: "reader@example.com",
  password: "journal-test-password",
  config: {
    ...loginConfig,
    emailSelector: "input[type='email']",
    passwordSelector: "input[type='password']",
    submitSelector: "button[type='submit']",
  },
};

test("a visible CSS locator ignores hidden ancestors and resolves the current field after replacement", async () => {
  const browser = await launchScrapingBrowser();
  try {
    const page = await createScrapingPage(browser);
    await page.setContent(`
      <section hidden><input type="email"></section>
      <section style="display:none"><input type="email"></section>
      <section style="visibility:hidden"><input type="email"></section>
      <section style="opacity:0"><input type="email"></section>
      <section inert><input type="email"></section>
      <main><input id="visible" type="email"></main>
    `);
    const selector = visibleJournalSelector("input[type='email']");
    expect(await page.$$eval(selector, (elements) => elements.length)).toBe(1);
    await (await page.waitForSelector(selector, { visible: true }))?.dispose();
    await page.locator(selector).fill("first@example.com");
    await page.evaluate(() => {
      const field = document.querySelector("#visible")!;
      field.outerHTML = '<input id="replacement" type="email">';
    });
    await page.locator(selector).fill("second@example.com");
    expect(
      await page.$$eval(selector, (elements) =>
        elements.map((element) => (element as HTMLInputElement).value),
      ),
    ).toEqual(["second@example.com"]);
    expect(
      await page.$$eval("section input", (elements) =>
        elements.every((element) => (element as HTMLInputElement).value === ""),
      ),
    ).toBe(true);
  } finally {
    await browser.close();
  }
}, 15000);

test.each(["hidden", 'style="opacity:0"'])(
  "fills and submits the unique visible controls when matching hidden controls appear first: %s",
  async (hiddenAttributes) => {
    const fixture = journalFixture();
    const browser = new JournalLoginBrowser(async (url, options) => {
      const response = await fixture.fetch(url, options);
      if (new URL(url).pathname === "/login")
        return {
          ...response,
          text: `<section ${hiddenAttributes}>
              <form method="post" action="/authenticate">
                <input type="email" name="email"><input type="password" name="password">
                <button type="submit">Connexion masquée</button>
              </form>
            </section>${response.text.replace('<button id="submit">', '<button id="submit" type="submit">')}`,
        };
      return response;
    }, 1500);

    const result = await browser.run(
      "publisher.example",
      credentials,
      "https://publisher.example/article",
    );
    expect(result.contentHtml).toContain(fullText);
    const posts = fixture.requests.filter((request) => request.options?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(new URLSearchParams(posts[0]!.options?.body).get("email")).toBe(credentials.email);
    expect(new URLSearchParams(posts[0]!.options?.body).get("password")).toBe(credentials.password);
  },
  15000,
);

test("refuses a login selector with two visible fields before sending credentials", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) => {
    const response = await fixture.fetch(url, options);
    return new URL(url).pathname === "/login"
      ? { ...response, text: '<input type="email">' + response.text }
      : response;
  }, 1500);
  await assert.rejects(browser.run("publisher.example", credentials), {
    code: "JOURNAL_LOGIN_SELECTOR_AMBIGUOUS",
  });
  expect(fixture.requests.some((request) => request.options?.method === "POST")).toBe(false);
}, 15000);

test("supports a JavaScript form with an implicit GET method when its actual authentication request uses POST", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) => {
    if (new URL(url).pathname === "/authenticate") {
      const response = await fixture.fetch(url, options);
      return {
        ...response,
        status: 200,
        location: undefined,
        contentType: "application/json",
        text: '{"authenticated":true}',
      };
    }
    const response = await fixture.fetch(url, options);
    if (new URL(url).pathname === "/login")
      return {
        ...response,
        text:
          response.text
            .replace('method="post"', "")
            .replace('<button id="submit">', '<button id="submit" type="submit">') +
          `<script>
            document.querySelector('form').addEventListener('submit', async event => {
              event.preventDefault();
              const response = await fetch('/authenticate', {
                method: 'POST', body: new URLSearchParams(new FormData(event.target)),
              });
              if ((await response.json()).authenticated) location.href = '/account';
            });
          </script>`,
      };
    return response;
  }, 1500);
  const result = await browser.run(
    "publisher.example",
    credentials,
    "https://publisher.example/article",
  );
  expect(result.contentHtml).toContain(fullText);
  const post = fixture.requests.find((request) => request.url.endsWith("/authenticate"));
  expect(post?.options?.method).toBe("POST");
  expect(new URLSearchParams(post?.options?.body).get("password")).toBe(credentials.password);
  expect(
    fixture.requests.some((request) => new URL(request.url).searchParams.has("password")),
  ).toBe(false);
}, 15000);
