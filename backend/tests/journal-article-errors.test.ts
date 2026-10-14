import { strict as assert } from "node:assert";
import { expect, test } from "bun:test";
import { TimeoutError } from "puppeteer";
import { AppError, UpstreamHttpError } from "../src/errors";
import { JournalLoginBrowser } from "../src/journal-login";
import { fullText, journalFixture, loginConfig } from "./fixtures/journal-login";

const credentials = {
  email: "reader@example.com",
  password: "journal-test-password",
  config: loginConfig,
};
const queryToken = "synthetic-private-query-token";
const responseBody = "synthetic-private-response-body";
const sensitiveValues = [credentials.email, credentials.password, queryToken, responseBody];

function assertSanitized(error: unknown, code: string, observations: string[]) {
  expect(error).toBeInstanceOf(AppError);
  const applicationError = error as AppError;
  expect(applicationError.code).toBe(code);
  const exposed = JSON.stringify({
    ...applicationError,
    message: applicationError.message,
    stack: applicationError.stack,
    observations,
  });
  for (const sensitive of sensitiveValues) expect(exposed).not.toContain(sensitive);
  expect(exposed).not.toContain("https://publisher.example");
  expect(applicationError).not.toHaveProperty("url");
  return applicationError;
}

test("article HTTP refusals expose their status safely and keep the authenticated session usable", async () => {
  const fixture = journalFixture();
  const observations: string[] = [];
  const messages = new Map<number, string>();
  const browser = new JournalLoginBrowser(async (url, options) => {
    const path = new URL(url).pathname;
    const refused = path.match(/^\/article-status-(\d+)$/);
    if (refused)
      return {
        status: Number(refused[1]),
        cookies: [],
        text: `${responseBody} ${credentials.email} ${credentials.password}`,
        contentType: "text/html",
      };
    if (path === "/article-upstream")
      throw new UpstreamHttpError(
        403,
        `${url}&email=${credentials.email}&password=${credentials.password}&body=${responseBody}`,
      );
    return fixture.fetch(url, options);
  }, 3000);

  await browser.withSession(
    "publisher.example",
    credentials,
    async (read) => {
      for (const status of [403, 404, 429, 500]) {
        await assert.rejects(
          read(
            `https://publisher.example/article-status-${status}?token=${queryToken}`,
            (message) => observations.push(message),
          ),
          (error: unknown) => {
            const sanitized = assertSanitized(error, "JOURNAL_ARTICLE_HTTP_ERROR", observations);
            expect(sanitized.message).toContain(`HTTP ${status}`);
            messages.set(status, sanitized.message);
            return true;
          },
        );
      }
      await assert.rejects(
        read(`https://publisher.example/article-upstream?token=${queryToken}`),
        (error: unknown) => {
          const sanitized = assertSanitized(error, "JOURNAL_ARTICLE_HTTP_ERROR", observations);
          expect(sanitized.message).toBe(messages.get(403)!);
          return true;
        },
      );
      expect((await read("https://publisher.example/article")).contentHtml).toContain(fullText);
    },
    (message) => observations.push(message),
  );
  expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(1);
}, 20000);

test("transport and Puppeteer article timeouts expose the same safe failure without discarding the session", async () => {
  const fixture = journalFixture();
  const observations: string[] = [];
  const browser = new JournalLoginBrowser(async (url, options) => {
    const path = new URL(url).pathname;
    const privateMessage = `${url} ${credentials.email} ${credentials.password} ${responseBody}`;
    if (path === "/article-transport-timeout") throw new AppError(504, privateMessage, "TIMEOUT");
    if (path === "/article-browser-timeout") throw new TimeoutError(privateMessage);
    return fixture.fetch(url, options);
  }, 3000);

  await browser.withSession(
    "publisher.example",
    credentials,
    async (read) => {
      let expectedMessage: string | undefined;
      for (const path of ["article-transport-timeout", "article-browser-timeout"]) {
        await assert.rejects(
          read(`https://publisher.example/${path}?token=${queryToken}`),
          (error: unknown) => {
            const sanitized = assertSanitized(error, "JOURNAL_ARTICLE_PAGE_TIMEOUT", observations);
            if (expectedMessage) expect(sanitized.message).toBe(expectedMessage);
            expectedMessage = sanitized.message;
            return true;
          },
        );
      }
      expect((await read("https://publisher.example/article")).contentHtml).toContain(fullText);
    },
    (message) => observations.push(message),
  );
}, 20000);

test("an article document that never responds reaches the bounded page timeout without exposing its query", async () => {
  const fixture = journalFixture();
  const observations: string[] = [];
  let requested = false;
  const browser = new JournalLoginBrowser(async (url, options) => {
    if (new URL(url).pathname === "/article-pending") {
      requested = true;
      return new Promise(() => {});
    }
    return fixture.fetch(url, options);
  }, 700);

  await assert.rejects(
    browser.run(
      "publisher.example",
      credentials,
      `https://publisher.example/article-pending?token=${queryToken}`,
      (message) => observations.push(message),
    ),
    (error: unknown) => {
      assertSanitized(error, "JOURNAL_ARTICLE_PAGE_TIMEOUT", observations);
      return true;
    },
  );
  expect(requested).toBe(true);
}, 10000);
