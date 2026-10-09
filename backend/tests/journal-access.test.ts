import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { JournalAccessService, JournalSecretCipher, journalDomain } from "../src/journal-access";
import { ArticleContentService, assertPublicArticle } from "../src/article-content";
import { RssService, parseRss } from "../src/rss";
import { createApp } from "../src/app";
import { AppError } from "../src/errors";
import { config, db, redis, connect, disconnect } from "./helpers";
import type { ArticlePreview } from "@dailybrief/shared";

test("encrypts with unique nonces and binds secrets to account and exact hostname", () => {
  const cipher = new JournalSecretCipher(randomBytes(32).toString("hex"));
  const one = cipher.encrypt("password-secret", "u1", "www.lemonde.fr");
  expect(one).not.toContain("password-secret");
  expect(cipher.encrypt("password-secret", "u1", "www.lemonde.fr")).not.toBe(one);
  expect(cipher.decrypt(one, "u1", "www.lemonde.fr")).toBe("password-secret");
  expect(() => cipher.decrypt(one, "u2", "www.lemonde.fr")).toThrow();
  expect(() => cipher.decrypt(one, "u1", "lemonde.fr")).toThrow();
  const parts = one.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  expect(() => cipher.decrypt(parts.join(":"), "u1", "www.lemonde.fr")).toThrow();
  expect(() => new JournalSecretCipher().encrypt("secret", "u1", "site.fr")).toThrow();
  expect(journalDomain("https://WWW.LEMONDE.FR/article")).toBe("www.lemonde.fr");
  expect(journalDomain("https://lemonde.fr/article")).toBe("lemonde.fr");
});

test("selector feeds can include every item while direct feeds retain their limit", () => {
  const xml = `<rss><channel>${Array.from({ length: 501 }, (_, i) => `<item><title>${i}</title><link>https://notice.example/${i}</link></item>`).join("")}</channel></rss>`;
  expect(parseRss(xml, "https://notice.example/feed", true).articles).toHaveLength(501);
  expect(parseRss(xml, "https://notice.example/feed").articles).toHaveLength(500);
});

test("rejects subscription excerpts even when they contain enough text", () => {
  expect(() =>
    assertPublicArticle(
      '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script><article>Long public excerpt</article>',
    ),
  ).toThrow();
  expect(() => assertPublicArticle('<div class="paywall">Abonnez-vous</div>')).toThrow();
  assertPublicArticle("<article>Public</article>");
});

describe("journal inventory and credentials", () => {
  let userId = "";
  let otherId = "";
  let sourceId = "";
  let pages: string[] = [];
  let summaries = 0;
  let waitForPublicFetch: (() => Promise<void>) | undefined;
  const key = randomBytes(32).toString("hex");
  const cipher = new JournalSecretCipher(key);
  const content = new ArticleContentService(async (url) => {
    pages.push(url);
    const path = new URL(url).pathname;
    if (path === "/broken") throw new AppError(502, "Notice indisponible", "NETWORK_ERROR");
    if (url.startsWith("https://notice.example")) {
      const domain = path.startsWith("/lemonde") ? "www.lemonde.fr" : path.slice(1).split("/")[0];
      return `<a class="primarydoc" href="https://${domain}/article">Lire</a>`;
    }
    await waitForPublicFetch?.();
    return `<article><p>${"Contenu public détaillé. ".repeat(40)}</p></article>`;
  });
  const inventory = new JournalAccessService(db, content);
  const app = createApp(
    db,
    redis,
    { ...config, JOURNAL_ENCRYPTION_KEY: key },
    {
      articleContent: content,
      rss: new RssService(
        async () =>
          `<rss><channel><item><title>Connu</title><link>https://notice.example/lemonde1</link></item><item><title>Nouveau</title><link>https://notice.example/lemonde2</link></item><item><title>Erreur</title><link>https://notice.example/broken</link></item></channel></rss>`,
      ),
      summary: {
        summarize: async () => {
          summaries++;
          return { title: "Titre", summary: "Résumé", keyPoints: [] };
        },
      },
      email: {
        send: async () => {
          throw new Error("No email allowed");
        },
      },
    },
  );
  const agent = request.agent(app);
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(async () => {
    const email = `journals-${randomUUID()}@example.com`;
    userId = (
      await db.user.create({
        data: { email, passwordHash: await Bun.password.hash("Password123456") },
      })
    ).id;
    otherId = (
      await db.user.create({
        data: { email: `other-${randomUUID()}@example.com`, passwordHash: "unused" },
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
    await agent.post("/auth/login").send({ email, password: "Password123456" }).expect(200);
    pages = [];
    summaries = 0;
    waitForPublicFetch = undefined;
  });
  afterEach(async () => {
    const keys = await redis.keys(`dailybrief:workflow:${userId}:*`);
    if (keys.length) await redis.del(keys);
    await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  });
  const article = (path: string): ArticlePreview => ({
    title: path,
    url: `https://notice.example/${path}`,
    description: null,
    publishedAt: null,
  });
  test("simultaneous previews create one domain without resetting its access", async () => {
    const accesses = await Promise.all(
      Array.from({ length: 10 }, () => inventory.ensure(userId, "concurrent.example")),
    );
    expect(new Set(accesses.map((access) => access.id)).size).toBe(1);
    await db.journalAccess.update({ where: { id: accesses[0]!.id }, data: { enabled: true } });
    const repeated = await Promise.all(
      Array.from({ length: 10 }, () => inventory.ensure(userId, "concurrent.example")),
    );
    expect(repeated.every((access) => access.enabled)).toBe(true);
  });
  test("counts exact external hosts once, sorts descending then alphabetically, and preserves partial results", async () => {
    const result = await inventory.inventory(
      userId,
      [
        article("z.example/1"),
        article("a.example/1"),
        article("lemonde1"),
        article("lemonde2"),
        article("lemonde1"),
        article("broken"),
      ],
      "a.primarydoc",
    );
    expect(
      result.journals.map(({ domain, count, enabled }) => ({ domain, count, enabled })),
    ).toEqual([
      { domain: "www.lemonde.fr", count: 2, enabled: false },
      { domain: "a.example", count: 1, enabled: false },
      { domain: "z.example", count: 1, enabled: false },
    ]);
    expect(result.articles).toHaveLength(5);
    expect(result.articles.filter((item) => item.resolutionError)).toHaveLength(1);
    expect(pages.every((url) => new URL(url).hostname === "notice.example")).toBe(true);
    await db.journalAccess.update({
      where: { userId_domain: { userId, domain: "www.lemonde.fr" } },
      data: { enabled: true },
    });
    const next = await inventory.inventory(userId, [article("lemonde1")], "a.primarydoc");
    expect(next.journals[0]).toMatchObject({ count: 1, enabled: true });
    const other = await inventory.inventory(otherId, [article("lemonde1")], "a.primarydoc");
    expect(other.journals[0]?.enabled).toBe(false);
  });
  test("workflow resolves known items before AI, ignores disabled journals, and permits public activation", async () => {
    await db.article.create({
      data: {
        userId,
        sourceId,
        title: "Connu",
        url: "https://notice.example/lemonde1",
        fingerprint: randomUUID(),
        contentHash: randomUUID(),
        summary: "Existant",
      },
    });
    const before = await db.article.findMany({ where: { userId } });
    const preview = (await agent.post(`/sources/${sourceId}/workflow`).send({}).expect(200)).body;
    expect(preview.journals[0]).toMatchObject({
      domain: "www.lemonde.fr",
      count: 2,
      enabled: false,
    });
    expect(preview.articles[0]).toMatchObject({
      url: "https://notice.example/lemonde1",
      externalUrl: "https://www.lemonde.fr/article",
    });
    expect(pages).toHaveLength(3);
    expect(summaries).toBe(0);
    const summarize = () =>
      agent.post(`/sources/${sourceId}/workflow/${preview.id}/articles/0/summarize`).send({});
    expect((await summarize()).text).toContain("JOURNAL_DISABLED");
    expect(pages).toHaveLength(3);
    await agent.patch("/journals/www.lemonde.fr").send({ enabled: true }).expect(200);
    expect((await summarize()).text).toContain('"type":"result"');
    expect(summaries).toBe(1);
    expect(pages.at(-1)).toBe("https://www.lemonde.fr/article");
    await agent.patch("/journals/www.lemonde.fr").send({ enabled: false }).expect(200);
    expect((await summarize()).text).toContain("JOURNAL_DISABLED");
    expect(summaries).toBe(1);
    expect(await db.article.findMany({ where: { userId } })).toEqual(before);
    expect(await db.newsletter.count({ where: { userId } })).toBe(0);
  });
  test("disabling a journal during download prevents the following AI call", async () => {
    const preview = (await agent.post(`/sources/${sourceId}/workflow`).send({}).expect(200)).body;
    await agent.patch("/journals/www.lemonde.fr").send({ enabled: true }).expect(200);
    let started = () => {};
    let release = () => {};
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    waitForPublicFetch = async () => {
      started();
      await gate;
    };
    const pending = agent
      .post(`/sources/${sourceId}/workflow/${preview.id}/articles/0/summarize`)
      .send({})
      .then((response) => response);
    await fetching;
    await agent.patch("/journals/www.lemonde.fr").send({ enabled: false }).expect(200);
    release();
    expect((await pending).text).toContain("JOURNAL_DISABLED");
    expect(summaries).toBe(0);
  });
  test("credential API stores ciphertext, preserves blanks, replaces and deletes without returning secrets", async () => {
    await inventory.ensure(userId, "www.lemonde.fr");
    const path = "/journals/www.lemonde.fr";
    await agent
      .patch(path)
      .send({ email: "reader@example.com", password: "private-password" })
      .expect(409);
    const response = await agent
      .patch(path)
      .send({ enabled: true, email: "reader@example.com", password: "private-password" })
      .expect(200);
    expect(response.body).toEqual({
      domain: "www.lemonde.fr",
      enabled: true,
      email: "reader@example.com",
      hasCredentials: true,
      authenticationSupported: false,
      loginConfig: null,
    });
    expect(response.text).not.toContain("private-password");
    const where = { userId_domain: { userId, domain: "www.lemonde.fr" } };
    const encrypted = (await db.journalAccess.findUniqueOrThrow({ where })).encryptedPassword!;
    expect(encrypted).not.toContain("private-password");
    expect(cipher.decrypt(encrypted, userId, "www.lemonde.fr")).toBe("private-password");
    await agent.patch(path).send({ email: "reader@example.com", password: "" }).expect(200);
    expect((await db.journalAccess.findUniqueOrThrow({ where })).encryptedPassword).toBe(encrypted);
    await agent.patch(path).send({ email: "changed@example.com", password: "" }).expect(400);
    await agent.patch(path).send({ password: "replacement" }).expect(200);
    const replaced = (await db.journalAccess.findUniqueOrThrow({ where })).encryptedPassword!;
    expect(cipher.decrypt(replaced, userId, "www.lemonde.fr")).toBe("replacement");
    const repeated = await inventory.inventory(userId, [article("lemonde1")], "a.primarydoc");
    expect(repeated.journals[0]).toMatchObject({ enabled: true, hasCredentials: true });
    expect((await db.journalAccess.findUniqueOrThrow({ where })).encryptedPassword).toBe(replaced);
    await expect(
      inventory.assertAccessible(userId, "https://www.lemonde.fr/article"),
    ).rejects.toMatchObject({ code: "JOURNAL_AUTH_UNSUPPORTED" });
    await agent.patch(path).send({ clearCredentials: true }).expect(200);
    expect(await db.journalAccess.findUniqueOrThrow({ where })).toMatchObject({
      email: null,
      encryptedPassword: null,
      enabled: true,
    });
    await inventory.assertAccessible(userId, "https://www.lemonde.fr/article");
  });
  test("requires authentication, forbids cross-account edits and fails safely without a deployment key", async () => {
    await inventory.ensure(otherId, "private.example");
    await agent.patch("/journals/private.example").send({ enabled: true }).expect(404);
    await request(app).patch("/journals/private.example").send({ enabled: true }).expect(401);
    const noKey = createApp(db, redis, { ...config, JOURNAL_ENCRYPTION_KEY: undefined });
    const own = request.agent(noKey);
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    await own.post("/auth/login").send({ email: user.email, password: "Password123456" });
    await inventory.ensure(userId, "public.example");
    await own.patch("/journals/public.example").send({ enabled: true }).expect(200);
    await own
      .patch("/journals/public.example")
      .send({ email: "reader@example.com", password: "secret" })
      .expect(503);
    expect(
      (
        await db.journalAccess.findUniqueOrThrow({
          where: { userId_domain: { userId, domain: "public.example" } },
        })
      ).encryptedPassword,
    ).toBeNull();
  });
});
