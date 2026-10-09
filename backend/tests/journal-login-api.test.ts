import { strict as assert } from "node:assert";
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { randomUUID, randomBytes } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { JournalLoginBrowser } from "../src/journal-login";
import { JournalAccessService, JournalSecretCipher } from "../src/journal-access";
import { ArticleContentService } from "../src/article-content";
import { RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { SourceCollector } from "../src/collection";
import { DailyBriefPipelineService } from "../src/pipeline";
import { UserCollectionLock } from "../src/lock";
import { config, db, redis, connect, disconnect } from "./helpers";
import { journalFixture, loginConfig, fullText } from "./fixtures/journal-login";

describe("configured journal login API and pipeline", () => {
  let userId = "",
    sourceId = "";
  let summaries = 0,
    sends = 0;
  let failEmail = false;
  const key = randomBytes(32).toString("hex");
  const fixture = journalFixture();
  const browser = new JournalLoginBrowser(fixture.fetch);
  const content = new ArticleContentService(
    async () => '<a class="primarydoc" href="https://publisher.example/article">Lire</a>',
  );
  const cipher = new JournalSecretCipher(key);
  const journals = new JournalAccessService(db, content, cipher, browser);
  const rss = new RssService(
    async () =>
      "<rss><channel><item><title>Article abonné</title><link>https://notice.example/one</link></item></channel></rss>",
  );
  const summary = {
    summarize: async (input: { content: string }) => {
      summaries++;
      expect(input.content).toContain(fullText.trim());
      expect(input.content).not.toContain("journal-test-password");
      return { title: "Article", summary: "Résumé", keyPoints: [] };
    },
  };
  const email = {
    send: async () => {
      if (failEmail) throw new Error("SMTP fixture failure");
      sends++;
    },
  };
  const runner = new DailyBriefPipelineService(
    db,
    new SourceCollector(db, rss, new ScrapingService(), content),
    new UserCollectionLock(redis),
    summary,
    email,
    content,
    journals,
  );
  const app = createApp(
    db,
    redis,
    { ...config, JOURNAL_ENCRYPTION_KEY: key },
    { rss, articleContent: content, summary, email, runner, journalAccess: journals },
  );
  const agent = request.agent(app);
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(async () => {
    const address = `login-${randomUUID()}@example.com`;
    userId = (
      await db.user.create({
        data: {
          email: address,
          passwordHash: await Bun.password.hash("Password123456"),
          settings: { create: {} },
        },
      })
    ).id;
    sourceId = (
      await db.source.create({
        data: {
          userId,
          url: "https://notice.example/feed",
          type: "RSS",
          articleLinkSelector: "a.primarydoc",
        },
      })
    ).id;
    await journals.ensure(userId, "publisher.example");
    await agent
      .post("/auth/login")
      .send({ email: address, password: "Password123456" })
      .expect(200);
    fixture.requests.length = 0;
    Object.assign(fixture.state, {
      failed: false,
      expired: false,
      paywall: false,
      getForm: false,
      foreignPost: false,
      foreignRedirect: false,
      malicious: false,
      subscription: true,
    });
    summaries = sends = 0;
    failEmail = false;
  });
  afterEach(async () => {
    const keys = await redis.keys(`dailybrief:workflow:${userId}:*`);
    if (keys.length) await redis.del(keys);
    await db.user.delete({ where: { id: userId } });
  });
  async function configure() {
    return agent
      .patch("/journals/publisher.example")
      .send({
        enabled: true,
        email: "reader@example.com",
        password: "journal-test-password",
        loginConfig,
      })
      .expect(200);
  }
  test("persists form configuration, hides secrets, checks login and reads complete content without modifying production data", async () => {
    const saved = await configure();
    expect(saved.body.loginConfig).toMatchObject(loginConfig);
    expect(saved.body.authenticationSupported).toBe(true);
    expect(saved.text).not.toContain("journal-test-password");
    const connection = await agent.post("/journals/publisher.example/test").send({}).expect(200);
    expect(connection.body.authenticated).toBe(true);
    expect(connection.text).not.toContain("own-session");
    const preview = (await agent.post(`/sources/${sourceId}/workflow`).send({}).expect(200)).body;
    expect(preview.journals[0].loginConfig).toMatchObject(loginConfig);
    const response = await agent
      .post(`/sources/${sourceId}/workflow/${preview.id}/articles/0/summarize`)
      .send({})
      .expect(200);
    expect(response.text).toContain('"type":"result"');
    expect(response.text).toContain(fullText.trim());
    expect(response.text).not.toContain("journal-test-password");
    expect(response.text).not.toContain("own-session");
    expect(summaries).toBe(1);
    expect(sends).toBe(0);
    expect(await db.article.count({ where: { userId } })).toBe(0);
    expect(await db.newsletter.count({ where: { userId } })).toBe(0);
  }, 60000);
  test("rejects invalid login URLs, incomplete configurations and invalid CSS without changing saved access", async () => {
    await configure();
    const where = { userId_domain: { userId, domain: "publisher.example" } };
    const before = await db.journalAccess.findUniqueOrThrow({ where });
    for (const url of [
      "http://publisher.example/login",
      "https://127.0.0.1/login",
      "https://localhost/login",
      "https://publisher.example/login?password=secret",
      "https://name:secret@publisher.example/login",
    ]) {
      await agent
        .patch("/journals/publisher.example")
        .send({ loginConfig: { ...loginConfig, loginUrl: url } })
        .expect(400);
    }
    await agent
      .patch("/journals/publisher.example")
      .send({ loginConfig: { ...loginConfig, emailSelector: "[" } })
      .expect(400);
    await agent
      .patch("/journals/publisher.example")
      .send({ loginConfig: { loginUrl: loginConfig.loginUrl } })
      .expect(400);
    expect(await db.journalAccess.findUniqueOrThrow({ where })).toEqual(before);
  });
  test("requires owner authentication and keeps testing separate from configuration support", async () => {
    await request(app).post("/journals/publisher.example/test").send({}).expect(401);
    await agent.post("/journals/other.example/test").send({}).expect(404);
    await agent.post("/journals/publisher.example/test").send({}).expect(409);
    await configure();
    await agent
      .post("/journals/publisher.example/test")
      .send({ url: "https://attacker.example" })
      .expect(400);
    const otherId = (
      await db.user.create({
        data: { email: `other-${randomUUID()}@example.com`, passwordHash: "unused" },
      })
    ).id;
    try {
      await journals.ensure(otherId, "other.example");
      await agent.post("/journals/other.example/test").send({}).expect(404);
    } finally {
      await db.user.delete({ where: { id: otherId } });
    }
    fixture.state.failed = true;
    const failed = await agent.post("/journals/publisher.example/test").send({}).expect(422);
    expect(failed.body.code).toBe("JOURNAL_LOGIN_FAILED");
    expect(failed.text).not.toContain("journal-test-password");
    expect(
      (
        await db.journalAccess.findUniqueOrThrow({
          where: { userId_domain: { userId, domain: "publisher.example" } },
        })
      ).successSelector,
    ).toBe("#account");
  }, 60000);
  test("clearing the form preserves encrypted credentials, and clearing credentials preserves the form", async () => {
    await configure();
    const where = { userId_domain: { userId, domain: "publisher.example" } };
    const encrypted = (await db.journalAccess.findUniqueOrThrow({ where })).encryptedPassword;
    const cleared = await agent
      .patch("/journals/publisher.example")
      .send({ loginConfig: null })
      .expect(200);
    expect(cleared.body).toMatchObject({
      loginConfig: null,
      hasCredentials: true,
      authenticationSupported: false,
    });
    expect((await db.journalAccess.findUniqueOrThrow({ where })).encryptedPassword).toBe(encrypted);
    await agent
      .patch("/journals/publisher.example")
      .send({ loginConfig, password: "" })
      .expect(200);
    expect((await db.journalAccess.findUniqueOrThrow({ where })).encryptedPassword).toBe(encrypted);
    const removed = await agent
      .patch("/journals/publisher.example")
      .send({ clearCredentials: true })
      .expect(200);
    expect(removed.body).toMatchObject({ hasCredentials: false, loginConfig });
    await agent.post("/journals/publisher.example/test").send({}).expect(422);
  });
  test("subscriber metadata without a full-content selector cannot be presented as full text", async () => {
    await configure();
    await agent
      .patch("/journals/publisher.example")
      .send({ loginConfig: { ...loginConfig, articleContentSelector: null } })
      .expect(200);
    await assert.rejects(journals.fetchArticle(userId, "https://publisher.example/article"), {
      code: "JOURNAL_FULL_CONTENT_UNVERIFIED",
    });
    expect(summaries).toBe(0);
  }, 60000);
  for (const trigger of ["manual", "scheduled"] as const)
    test(`${trigger} collection uses authenticated content for AI and newsletter`, async () => {
      await configure();
      if (trigger === "scheduled")
        await db.dailyBriefSettings.update({
          where: { userId },
          data: { collectionEnabled: true, nextCollectionAt: new Date(Date.now() - 1000) },
        });
      const result = await runner.run(userId, trigger);
      expect(result.status).toBe("SENT");
      const journalList = (await agent.get("/journals").expect(200)).body;
      expect(journalList.journals[0].count).toBe(1);
      expect(journalList.lastInventoriedAt).toBeTruthy();
      expect(summaries).toBe(1);
      expect(sends).toBe(1);
      const article = await db.article.findFirstOrThrow({ where: { userId } });
      expect(article.content).toContain(fullText.trim());
      expect(article.contentAccessVersion).toBeTruthy();
      expect(article.url).toBe("https://notice.example/one");
      expect(article.contentUrl).toBe("https://publisher.example/article");
      expect(
        fixture.requests.find((request) => request.url.endsWith("/article"))?.options?.cookie,
      ).toContain("own-session");
    }, 60000);
  test("editing login credentials invalidates pending article content and its summary", async () => {
    await configure();
    failEmail = true;
    expect((await runner.run(userId)).status).toBe("FAILED");
    const before = await db.article.findFirstOrThrow({ where: { userId } });
    await agent
      .patch("/journals/publisher.example")
      .send({ email: "other@example.com", password: "new-journal-password" })
      .expect(200);
    fixture.requests.length = 0;
    failEmail = false;
    expect((await runner.run(userId)).status).toBe("SENT");
    const after = await db.article.findFirstOrThrow({ where: { userId } });
    expect(after.contentAccessVersion).not.toBe(before.contentAccessVersion);
    expect(summaries).toBe(2);
    expect(
      fixture.requests.find((request) => request.url.endsWith("/article"))?.options?.cookie,
    ).toContain("other-session");
  }, 60000);
});
