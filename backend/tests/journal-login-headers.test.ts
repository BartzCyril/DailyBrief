import { test, expect } from "bun:test";
import { JournalLoginBrowser } from "../src/journal-login";
import type { RemotePageOptions } from "../src/network";
import { journalFixture, loginConfig, fullText } from "./fixtures/journal-login";

const credentials = {
  email: "reader@example.com",
  password: "journal-test-password",
  config: loginConfig,
};

test.each([
  ["X-CSRF-Token", "synthetic-csrf-token"],
  ["X-XSRF-Token", "synthetic-xsrf-token"],
  ["Authorization", "Bearer synthetic-session-token"],
])(
  "preserves the browser's %s header for AJAX authentication without exposing it to observers",
  async (headerName, headerValue) => {
    const fixture = journalFixture();
    const messages: string[] = [];
    const browser = new JournalLoginBrowser(async (url, options) => {
      if (new URL(url).pathname === "/authenticate") {
        if (options?.applicationHeaders?.[headerName.toLowerCase()] !== headerValue)
          return {
            status: 403,
            cookies: [],
            contentType: "application/json",
            text: '{"authenticated":false}',
          };
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
            response.text +
            `<script>
              document.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                const response = await fetch('/authenticate', {
                  method: 'POST',
                  headers: { ${JSON.stringify(headerName)}: ${JSON.stringify(headerValue)} },
                  body: new URLSearchParams(new FormData(event.target)),
                });
                if ((await response.json()).authenticated) location.href = '/account';
              });
            </script>`,
        };
      return response;
    }, 3000);

    const result = await browser.run(
      "publisher.example",
      credentials,
      "https://publisher.example/article",
      (message) => messages.push(message),
    );

    expect(result.contentHtml).toContain(fullText);
    const authentication = fixture.requests.find(
      (request) => new URL(request.url).pathname === "/authenticate",
    );
    expect(authentication?.options?.applicationHeaders?.[headerName.toLowerCase()]).toBe(
      headerValue,
    );
    expect(authentication?.options?.accept).toBe("*/*");
    expect(authentication?.options?.browserHeaders).toBeDefined();
    expect(authentication?.options?.followRedirects).toBe(false);
    expect(
      fixture.requests.find((request) => new URL(request.url).pathname === "/article")?.options
        ?.cookie,
    ).toContain("sid=own-session");
    const observations = messages.join("\n");
    for (const secret of [headerValue, credentials.email, credentials.password]) {
      expect(observations).not.toContain(secret);
      expect(result.html).not.toContain(secret);
    }
  },
  15000,
);

test("preserves an allowed CSRF header and the server's CORS policy between the configured login and journal origins", async () => {
  const fixture = journalFixture();
  const loginOrigin = "https://secure.publisher.example";
  const headerValue = "synthetic-cross-origin-csrf-token";
  const calls: { url: string; options?: RemotePageOptions }[] = [];
  const browser = new JournalLoginBrowser(async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (path === "/authenticate" && options?.method === "OPTIONS")
      return {
        status: 204,
        cookies: [],
        text: "",
        corsHeaders: {
          "access-control-allow-origin": loginOrigin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "POST",
          "access-control-allow-headers": "x-csrf-token",
        },
      };
    if (path === "/authenticate") {
      if (options?.applicationHeaders?.["x-csrf-token"] !== headerValue)
        return { status: 403, cookies: [], text: "Missing CSRF token" };
      const response = await fixture.fetch(url, options);
      return {
        ...response,
        status: 200,
        location: undefined,
        cookies: ["sid=own-session; Domain=.publisher.example; Path=/; HttpOnly; Secure"],
        contentType: "application/json",
        text: '{"authenticated":true}',
        corsHeaders: {
          "access-control-allow-origin": loginOrigin,
          "access-control-allow-credentials": "true",
        },
      };
    }
    const response = await fixture.fetch(url, options);
    if (path === "/login")
      return {
        ...response,
        text:
          response.text +
          `<script>
            document.querySelector('form').addEventListener('submit', async event => {
              event.preventDefault();
              const response = await fetch('https://publisher.example/authenticate', {
                method: 'POST', credentials: 'include',
                headers: { 'X-CSRF-Token': ${JSON.stringify(headerValue)} },
                body: new URLSearchParams(new FormData(event.target)),
              });
              if ((await response.json()).authenticated)
                location.href = 'https://publisher.example/account';
            });
          </script>`,
      };
    return response;
  }, 3000);

  const result = await browser.run(
    "publisher.example",
    { ...credentials, config: { ...loginConfig, loginUrl: `${loginOrigin}/login` } },
    "https://publisher.example/article",
  );
  expect(result.contentHtml).toContain(fullText);
  const preflight = calls.find((request) => request.options?.method === "OPTIONS");
  expect(preflight?.options?.origin).toBe(loginOrigin);
  expect(preflight?.options?.corsRequestMethod).toBe("POST");
  expect(preflight?.options?.corsRequestHeaders).toContain("x-csrf-token");
  const authentication = calls.find((request) => request.options?.method === "POST");
  expect(authentication?.options?.origin).toBe(loginOrigin);
  expect(authentication?.options?.applicationHeaders?.["x-csrf-token"]).toBe(headerValue);
  expect(
    fixture.requests.find((request) => new URL(request.url).pathname === "/article")?.options
      ?.cookie,
  ).toContain("sid=own-session");
}, 15000);
