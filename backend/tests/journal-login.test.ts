import { strict as assert } from "node:assert";
import { test, expect, spyOn } from "bun:test";
import type { Browser } from "puppeteer";
import { scrapingBrowser } from "../src/browser";
import { JournalLoginBrowser } from "../src/journal-login";
import { RemoteConnectionError } from "../src/network";
import { journalFixture, loginConfig, fullText } from "./fixtures/journal-login";

const credentials = {
  email: "reader@example.com",
  password: "journal-test-password",
  config: loginConfig,
};

test("reads concurrent batch requests in one browser, authenticates once, and closes before returning", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(fixture.fetch);
  const launch = spyOn(scrapingBrowser, "launch");
  const ids = Array.from({ length: 13 }, (_, index) => index + 1);
  try {
    const pages = await browser.withSession("publisher.example", credentials, (read) =>
      Promise.all(ids.map((id) => read(`https://publisher.example/article-${id}`))),
    );
    expect(pages.map((page) => page.url)).toEqual(
      ids.map((id) => `https://publisher.example/article-${id}`),
    );
    expect(pages.every((page) => page.contentHtml?.includes(fullText))).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    expect((await (launch.mock.results[0]!.value as Promise<Browser>)).isConnected()).toBe(false);
    expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
      1,
    );
    expect(
      fixture.requests
        .filter((request) => request.url.includes("/article-"))
        .map((request) => request.options?.cookie),
    ).toEqual(Array(ids.length).fill("sid=own-session"));
  } finally {
    launch.mockRestore();
  }
}, 90000);

test("a missing article does not discard the authenticated session or prevent the next read", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) =>
    url.endsWith("/missing")
      ? { status: 404, cookies: [], text: "Absent", contentType: "text/html" }
      : fixture.fetch(url, options),
  );
  await browser.withSession("publisher.example", credentials, async (read) => {
    await assert.rejects(read("https://publisher.example/missing"), {
      code: "JOURNAL_ARTICLE_UNAVAILABLE",
    });
    expect((await read("https://publisher.example/article")).contentHtml).toContain(fullText);
  });
  expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(1);
}, 45000);

test("an expired batch session fails subsequent reads without attempting another login and closes on callback failure", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(fixture.fetch);
  const launch = spyOn(scrapingBrowser, "launch");
  try {
    await assert.rejects(
      browser.withSession("publisher.example", credentials, async (read) => {
        await read("https://publisher.example/article-1");
        fixture.state.expired = true;
        await assert.rejects(read("https://publisher.example/article-2"), {
          code: "JOURNAL_SESSION_EXPIRED",
        });
        await assert.rejects(read("https://publisher.example/article-3"), {
          code: "JOURNAL_SESSION_EXPIRED",
        });
        throw new Error("Batch callback stopped");
      }),
      /Batch callback stopped/,
    );
    expect(
      fixture.requests
        .filter((request) => request.url.includes("/article-"))
        .map((request) => request.url),
    ).toEqual(["https://publisher.example/article-1", "https://publisher.example/article-2"]);
    expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
      1,
    );
    expect((await (launch.mock.results[0]!.value as Promise<Browser>)).isConnected()).toBe(false);
  } finally {
    launch.mockRestore();
  }
}, 60000);

test("confirms a newly visible logout control without a user-supplied success selector despite unrelated malformed links", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) => {
    const response = await fixture.fetch(url, options);
    if (url.endsWith("/account"))
      return {
        ...response,
        text: response.text + '<a>Lire</a><a href="http://[">Lien cassé</a>',
      };
    return response;
  });
  const result = await browser.run(
    "publisher.example",
    { ...credentials, config: { ...loginConfig, successSelector: null } },
    "https://publisher.example/article",
  );
  expect(result.contentHtml).toContain(fullText);
  expect(
    fixture.requests.find((request) => request.url.endsWith("/article"))?.options?.cookie,
  ).toContain("sid=own-session");
}, 45000);

test("confirms a new logout control when a public account link was already visible before login", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) => {
    const response = await fixture.fetch(url, options);
    if (url.endsWith("/login"))
      return { ...response, text: response.text + '<a href="/account">Mon compte</a>' };
    if (url.endsWith("/account"))
      return { ...response, text: '<button aria-label="Se déconnecter"></button>' };
    return response;
  });
  await browser.run("publisher.example", {
    ...credentials,
    config: { ...loginConfig, successSelector: null },
  });
  expect(fixture.requests.some((request) => request.options?.method === "POST")).toBe(true);
}, 45000);

test.each([
  "wrong-password",
  "public-account",
  "public-logout",
  "account-only",
  "redirect-only",
  "hidden-account",
  "password-remains",
])(
  "does not confirm an ambiguous automatic login: %s",
  async (scenario) => {
    const fixture = journalFixture();
    fixture.state.failed = scenario === "wrong-password";
    const browser = new JournalLoginBrowser(async (url, options) => {
      const response = await fixture.fetch(url, options);
      if (url.endsWith("/login") && scenario === "public-account")
        return { ...response, text: response.text + '<a href="/account">Mon compte</a>' };
      if (url.endsWith("/login") && scenario === "public-logout")
        return { ...response, text: response.text + "<button>Se déconnecter</button>" };
      if (url.endsWith("/account")) {
        if (scenario === "public-account" || scenario === "account-only")
          return { ...response, text: '<a href="/account">Mon compte</a>' };
        if (scenario === "redirect-only") return { ...response, text: "<main>Bienvenue</main>" };
        if (scenario === "hidden-account")
          return { ...response, text: "<button hidden>Se déconnecter</button>" };
        if (scenario === "password-remains")
          return { ...response, text: response.text + '<input type="password">' };
      }
      return response;
    }, 700);
    await assert.rejects(
      browser.run("publisher.example", {
        ...credentials,
        config: { ...loginConfig, successSelector: null },
      }),
      { code: "JOURNAL_LOGIN_UNVERIFIED" },
    );
    expect(fixture.requests.some((request) => request.url.endsWith("/article"))).toBe(false);
  },
  45000,
);

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

test("a third-party iframe on the public login page does not stop credential entry", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) => {
    const response = await fixture.fetch(url, options);
    return url.endsWith("/login")
      ? {
          ...response,
          text:
            response.text +
            '<iframe src="https://www.googletagmanager.com/ns.html?id=public-tag"></iframe><iframe src="https://127.0.0.1/private"></iframe>',
        }
      : response;
  }, 1000);
  const result = await browser.run(
    "publisher.example",
    credentials,
    "https://publisher.example/article",
  );
  expect(result.contentHtml).toContain(fullText);
  const post = fixture.requests.find((request) => request.options?.method === "POST");
  expect(new URLSearchParams(post?.options?.body).get("email")).toBe(credentials.email);
  expect(new URLSearchParams(post?.options?.body).get("password")).toBe(credentials.password);
  expect(
    fixture.requests.some((request) => /googletagmanager|127\.0\.0\.1/.test(request.url)),
  ).toBe(false);
}, 45000);

test("fills the visible login form while a same-origin child frame is still loading", async () => {
  const fixture = journalFixture();
  const messages: string[] = [];
  const browser = new JournalLoginBrowser(async (url, options) => {
    if (url.endsWith("/pending-frame")) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { status: 200, cookies: [], text: "<p>Chargé</p>", contentType: "text/html" };
    }
    const response = await fixture.fetch(url, options);
    return url.endsWith("/login")
      ? { ...response, text: response.text + '<iframe src="/pending-frame"></iframe>' }
      : response;
  }, 700);
  await browser.run("publisher.example", credentials, undefined, (message) =>
    messages.push(message),
  );
  const posts = fixture.requests.filter((request) => request.options?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(new URLSearchParams(posts[0]!.options?.body).get("email")).toBe(credentials.email);
  expect(new URLSearchParams(posts[0]!.options?.body).get("password")).toBe(credentials.password);
  expect(messages).toContain("Connexion au journal vérifiée dans cette session.");
}, 45000);

test("a document that never finishes loading reports a page timeout before credential entry", async () => {
  const messages: string[] = [];
  const browser = new JournalLoginBrowser(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      status: 200,
      cookies: [],
      text: "<main>Chargé trop tard</main>",
      contentType: "text/html",
    };
  }, 700);
  await assert.rejects(
    browser.run("publisher.example", credentials, undefined, (message) => messages.push(message)),
    { code: "JOURNAL_LOGIN_PAGE_TIMEOUT" },
  );
  expect(messages).not.toContain("Saisie des identifiants dans le formulaire de connexion.");
}, 45000);

test.each(["DNS", "TLS", "CONNECT", "RESET", "UNKNOWN"] as const)(
  "reports the network failure before credential entry without guessing a CAPTCHA: %s",
  async (reason) => {
    const messages: string[] = [];
    const browser = new JournalLoginBrowser(async () => {
      throw new RemoteConnectionError(reason);
    }, 700);
    await assert.rejects(
      browser.run("publisher.example", credentials, undefined, (message) => messages.push(message)),
      (error: unknown) => {
        expect(error).toMatchObject({ code: `JOURNAL_LOGIN_NETWORK_${reason}` });
        expect((error as Error).message).not.toContain("CAPTCHA");
        expect((error as Error).message).not.toContain(credentials.password);
        return true;
      },
    );
    expect(messages).not.toContain("Saisie des identifiants dans le formulaire de connexion.");
  },
  45000,
);

test("reports an HTTP refusal of the login page before any credential entry", async () => {
  const messages: string[] = [];
  const browser = new JournalLoginBrowser(
    async () => ({
      status: 403,
      cookies: [],
      text: "HTTP refusal without CAPTCHA",
      contentType: "text/html",
    }),
    700,
  );
  await assert.rejects(
    browser.run("publisher.example", credentials, undefined, (message) => messages.push(message)),
    { code: "JOURNAL_LOGIN_PAGE_HTTP_ERROR" },
  );
  expect(messages).not.toContain("Saisie des identifiants dans le formulaire de connexion.");
}, 45000);

test("fills the fields before waiting for a submit control revealed by input validation", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) => {
    const response = await fixture.fetch(url, options);
    return url.endsWith("/login")
      ? {
          ...response,
          text:
            response.text.replace('<button id="submit">', '<button id="submit" hidden>') +
            '<script>document.addEventListener("input", () => { if (document.querySelector("#email").value && document.querySelector("#password").value) document.querySelector("#submit").hidden = false; });</script>',
        }
      : response;
  }, 1000);
  await browser.run("publisher.example", credentials);
  const posts = fixture.requests.filter((request) => request.options?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(new URLSearchParams(posts[0]!.options?.body).get("password")).toBe(credentials.password);
}, 45000);

test.each([
  ["emailSelector", "JOURNAL_LOGIN_EMAIL_NOT_FOUND"],
  ["passwordSelector", "JOURNAL_LOGIN_PASSWORD_NOT_FOUND"],
  ["submitSelector", "JOURNAL_LOGIN_SUBMIT_NOT_FOUND"],
] as const)(
  "identifies the missing login control without submitting secrets: %s",
  async (selector, code) => {
    const fixture = journalFixture();
    const messages: string[] = [];
    const browser = new JournalLoginBrowser(fixture.fetch, 700);
    await assert.rejects(
      browser.run(
        "publisher.example",
        { ...credentials, config: { ...loginConfig, [selector]: "#missing" } },
        undefined,
        (message) => messages.push(message),
      ),
      { code },
    );
    expect(fixture.requests.some((request) => request.options?.method === "POST")).toBe(false);
    if (selector === "submitSelector")
      expect(messages).toContain("Champs de connexion remplis et vérifiés.");
    expect(messages.join(" ")).not.toContain(credentials.email);
    expect(messages.join(" ")).not.toContain(credentials.password);
  },
  45000,
);

test.each(["replace-fields", "replace-button", "reset-once"])(
  "fills and submits the live login form after JavaScript changes: %s",
  async (scenario) => {
    const fixture = journalFixture();
    const browser = new JournalLoginBrowser(async (url, options) => {
      const response = await fixture.fetch(url, options);
      if (url.endsWith("/login"))
        return {
          ...response,
          text:
            response.text +
            `<script>
              let changed = false;
              document.addEventListener(${JSON.stringify(scenario === "reset-once" ? "change" : "input")}, (event) => {
                if (changed || event.target.id !== ${JSON.stringify(scenario === "replace-button" ? "password" : "email")}) return;
                changed = true;
                if (${JSON.stringify(scenario)} === "reset-once") document.querySelector("form").reset();
                if (${JSON.stringify(scenario)} !== "replace-button") {
                  const password = document.querySelector("#password");
                  password.replaceWith(password.cloneNode(true));
                }
                const submit = document.querySelector("#submit");
                submit.replaceWith(submit.cloneNode(true));
              });
            </script>`,
        };
      return response;
    }, 1000);
    const result = await browser.run(
      "publisher.example",
      credentials,
      "https://publisher.example/article",
    );
    expect(result.contentHtml).toContain(fullText);
    const posts = fixture.requests.filter((request) => request.options?.method === "POST");
    expect(posts).toHaveLength(1);
    const body = new URLSearchParams(posts[0]!.options?.body);
    expect(body.get("email")).toBe(credentials.email);
    expect(body.get("password")).toBe(credentials.password);
  },
  45000,
);

test("does not submit credentials when JavaScript keeps clearing a filled field", async () => {
  const fixture = journalFixture();
  const messages: string[] = [];
  const browser = new JournalLoginBrowser(async (url, options) => {
    const response = await fixture.fetch(url, options);
    return url.endsWith("/login")
      ? {
          ...response,
          text:
            response.text +
            '<script>document.querySelector("#password").addEventListener("change", event => { event.target.value = ""; });</script>',
        }
      : response;
  }, 1000);
  await assert.rejects(
    browser.run("publisher.example", credentials, undefined, (message) => messages.push(message)),
    { code: "JOURNAL_LOGIN_FIELDS_UNFILLED" },
  );
  expect(fixture.requests.some((request) => request.options?.method === "POST")).toBe(false);
  expect(messages.join(" ")).not.toContain(credentials.password);
  expect(messages.join(" ")).not.toContain(credentials.email);
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

test("the configured login form can POST to the journal origin in the same authenticated session", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) => {
    const response = await fixture.fetch(url, options);
    return url.endsWith("/login")
      ? {
          ...response,
          text: response.text.replace(
            'action="/authenticate"',
            'action="https://publisher.example/authenticate"',
          ),
        }
      : response;
  });
  const result = await browser.run(
    "publisher.example",
    {
      ...credentials,
      config: { ...loginConfig, loginUrl: "https://accounts.publisher.example/login" },
    },
    "https://publisher.example/article",
  );
  expect(result.contentHtml).toContain(fullText);
  const posts = fixture.requests.filter((request) => request.options?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe("https://publisher.example/authenticate");
  expect(new URLSearchParams(posts[0]!.options?.body).get("password")).toBe(credentials.password);
}, 45000);

test("verifies login when the journal page checks its session by POST after the login redirect", async () => {
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(async (url, options) => {
    if (url.endsWith("/session-state")) {
      fixture.requests.push({ url, options });
      expect(options?.method).toBe("POST");
      expect(options?.cookie).toContain("sid=own-session");
      return {
        status: 200,
        cookies: [],
        text: '{"authenticated":true}',
        contentType: "application/json",
      };
    }
    const response = await fixture.fetch(url, options);
    if (url.endsWith("/authenticate"))
      return {
        ...response,
        location: "https://publisher.example/account",
        cookies: ["sid=own-session; Domain=publisher.example; Path=/; HttpOnly; Secure"],
      };
    if (url.endsWith("/account"))
      return {
        ...response,
        text: '<main></main><script>fetch("/session-state", {method:"POST", body:"check"}).then(r => r.json()).then(data => { if (data.authenticated) document.querySelector("main").innerHTML = "<button>Se déconnecter</button>"; });</script>',
      };
    return response;
  });
  const result = await browser.run(
    "publisher.example",
    {
      ...credentials,
      config: {
        ...loginConfig,
        loginUrl: "https://accounts.publisher.example/login",
        successSelector: null,
      },
    },
    "https://publisher.example/article",
  );
  expect(result.contentHtml).toContain(fullText);
  expect(fixture.requests.filter((request) => request.url.endsWith("/session-state"))).toHaveLength(
    1,
  );
}, 45000);

test.each([true, false])(
  "honors the server's CORS authorization for AJAX login between the configured origins: %s",
  async (corsAllowed) => {
    const fixture = journalFixture();
    const loginOrigin = "https://accounts.publisher.example";
    const browser = new JournalLoginBrowser(
      async (url, options) => {
        if (url.endsWith("/authenticate")) {
          fixture.requests.push({ url, options });
          const corsHeaders = {
            "access-control-allow-origin": corsAllowed ? loginOrigin : "https://attacker.example",
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "content-type",
          };
          if (options?.method === "OPTIONS")
            return {
              status: 204,
              cookies: [],
              text: "",
              contentType: "application/json",
              corsHeaders,
            };
          expect(options?.origin).toBe(loginOrigin);
          expect(JSON.parse(options?.body ?? "{}")).toEqual({
            email: credentials.email,
            password: credentials.password,
          });
          return {
            status: 200,
            cookies: ["sid=own-session; Path=/; HttpOnly; Secure"],
            text: '{"authenticated":true}',
            contentType: "application/json",
            corsHeaders,
          };
        }
        const response = await fixture.fetch(url, options);
        if (url.endsWith("/login"))
          return {
            ...response,
            text:
              response.text +
              '<script>document.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); const body = JSON.stringify(Object.fromEntries(new FormData(event.target))); const response = await fetch("https://publisher.example/authenticate", {method:"POST", credentials:"include", headers:{"Content-Type":"application/json"}, body}); if ((await response.json()).authenticated) location.href = "https://publisher.example/account"; });</script>',
          };
        return response;
      },
      corsAllowed ? 15000 : 700,
    );
    const login = browser.run(
      "publisher.example",
      { ...credentials, config: { ...loginConfig, loginUrl: `${loginOrigin}/login` } },
      "https://publisher.example/article",
    );
    if (corsAllowed) expect((await login).contentHtml).toContain(fullText);
    else await assert.rejects(login, { code: "JOURNAL_LOGIN_FAILED" });
    const preflights = fixture.requests.filter((request) => request.options?.method === "OPTIONS");
    expect(preflights).toHaveLength(1);
    expect(preflights[0]!.options?.origin).toBe(loginOrigin);
    expect(preflights[0]!.options?.corsRequestMethod).toBe("POST");
    expect(preflights[0]!.options?.corsRequestHeaders).toContain("content-type");
    expect(fixture.requests.filter((request) => request.options?.method === "POST")).toHaveLength(
      corsAllowed ? 1 : 0,
    );
  },
  45000,
);

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
    { code: "JOURNAL_LOGIN_EMAIL_NOT_FOUND" },
  );
  await assert.rejects(
    new JournalLoginBrowser(async () => {
      throw new Error(`password=${credentials.password}`);
    }, 700).run("publisher.example", credentials),
    (error: unknown) => {
      expect(error).toMatchObject({ code: "JOURNAL_LOGIN_PAGE_FAILED" });
      expect((error as Error).message).not.toContain(credentials.password);
      return true;
    },
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
    { code: "JOURNAL_LOGIN_REQUEST_BLOCKED" },
  );
}, 45000);
