import { expect, test } from "bun:test";
import { JournalHttpError, journalHttpError } from "../src/journal-http-error";

test("distinguishes an explicit automated-traffic refusal from a subscription refusal", () => {
  const automated = journalHttpError(
    402,
    `<title>Accès restreint - Journal</title><main><h1>Accès restreint</h1>
      <p>Votre trafic a été identifié comme automatisé (bot).</p></main>`,
  );
  expect(automated).toMatchObject({ status: 422, code: "JOURNAL_ARTICLE_AUTOMATION_BLOCKED" });
  expect(automated).toBeInstanceOf(JournalHttpError);
  expect(automated.message).toContain("HTTP 402");

  const subscription = journalHttpError(
    402,
    `<title>Actualité</title><article><h1>Une actualité</h1><section class="paywall">
      <p>Abonnez-vous pour lire la suite de cet article.</p></section></article>`,
  );
  expect(subscription).toMatchObject({ code: "JOURNAL_ARTICLE_SUBSCRIPTION_REQUIRED" });
  expect(subscription.message).toContain("réclame un accès abonné");
  expect(subscription.message).not.toContain("expiré");
});

test("recognizes English commercial-licensing and subscription gate messages", () => {
  expect(
    journalHttpError(
      402,
      "<title>Commercial License Required</title><p>Automated access for AI training requires a commercial agreement.</p>",
    ),
  ).toMatchObject({ code: "JOURNAL_ARTICLE_AUTOMATION_BLOCKED" });
  expect(
    journalHttpError(
      402,
      "<title>Subscription required</title><p>To read this article, subscribe to our publication.</p>",
    ),
  ).toMatchObject({ code: "JOURNAL_ARTICLE_SUBSCRIPTION_REQUIRED" });
});

test("recognizes refusal text in adjoining blocks without disclosing a challenge token", () => {
  const error = journalHttpError(
    402,
    `<title>Access denied</title><h1>Access denied</h1><form>Automated requests are blocked.<input value="SYNTHETIC_PRIVATE_CHALLENGE_34027"></form>`,
  );
  expect(error).toMatchObject({ code: "JOURNAL_ARTICLE_AUTOMATION_BLOCKED" });
  expect(error.message).not.toContain("SYNTHETIC_PRIVATE_CHALLENGE_34027");
  expect(
    journalHttpError(
      402,
      `<title>Actualité</title><section class="paywall"><a href="/abonnement">Abonnez-vous</a><p>pour lire la suite.</p></section>`,
    ),
  ).toMatchObject({ code: "JOURNAL_ARTICLE_SUBSCRIPTION_REQUIRED" });
});

test("keeps 402 indeterminate when its body does not explicitly identify a refused access", () => {
  for (const html of [
    undefined,
    "<title>Accès restreint</title><p>Une erreur est survenue.</p>",
    "<title>Actualité</title><article><h1>Les licences des robots</h1><p>Automated access for AI training requires a commercial agreement, explains the publisher.</p></article>",
    "<title>Actualité</title><article><p>Abonnez-vous pour lire la suite est un exemple de texte publicitaire.</p></article>",
    "<title>Accès restreint</title><script>const message = 'Votre trafic a été identifié comme automatisé (bot)';</script>",
  ])
    expect(journalHttpError(402, html)).toMatchObject({ code: "JOURNAL_ARTICLE_HTTP_ERROR" });
});

test("never discloses response tokens, cookies, addresses or request identifiers", () => {
  const sensitive = [
    "SYNTHETIC_PRIVATE_COOKIE_80291",
    "SYNTHETIC_PRIVATE_TOKEN_47283",
    "203.0.113.24",
    "SYNTHETIC_PRIVATE_RID_92402",
    "https://journal.example/private?credential=SYNTHETIC_PRIVATE_TOKEN_47283",
  ];
  const html = `<title>Accès restreint</title><p>Votre trafic a été identifié comme automatisé (bot).</p><p>${sensitive.join(" ")}</p>`;
  for (const error of [journalHttpError(402, html), journalHttpError(403, html)]) {
    const disclosed = `${error.message} ${JSON.stringify(error)}`;
    for (const value of sensitive) expect(disclosed).not.toContain(value);
    expect(error).not.toHaveProperty("html");
    expect(error).not.toHaveProperty("url");
  }
  const first = journalHttpError(402, html);
  first.message = sensitive[0]!;
  expect(journalHttpError(402, html).message).not.toContain(sensitive[0]!);
});

test("preserves valid error statuses and does not reinterpret another HTTP error as 402", () => {
  const html =
    "<title>Accès restreint</title><p>Votre trafic a été identifié comme automatisé (bot).</p>";
  for (const status of [400, 401, 403, 404, 429, 500, 599]) {
    const error = journalHttpError(status, html);
    expect(error.code).toBe("JOURNAL_ARTICLE_HTTP_ERROR");
    expect(error.message).toContain(`HTTP ${status}`);
  }
  for (const status of [200, 399, 600, 402.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(journalHttpError(status, html).message).not.toMatch(/HTTP \d/);
});
