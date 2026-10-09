import { beforeAll, afterAll, beforeEach, afterEach, test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { config, db, redis, connect, disconnect } from "./helpers";
import { createApp } from "../src/app";
import { JournalAccessService, JournalSecretCipher } from "../src/journal-access";
import { recordJournalInventory } from "../src/journal-inventory";
import { ArticleContentService } from "../src/article-content";
import { RssService } from "../src/rss";
import { loginConfig } from "./fixtures/journal-login";

const cipher = new JournalSecretCipher(randomBytes(32).toString("hex"));
const content = new ArticleContentService(
  async () => '<a class="primarydoc" href="https://paper.example/story">Lire</a>',
);
const journals = new JournalAccessService(db, content, cipher);
const app = createApp(db, redis, config, {
  articleContent: content,
  journalAccess: journals,
  rss: new RssService(
    async () =>
      "<rss><channel><item><title>Une notice</title><link>https://notice.example/one</link></item><item><title>Une autre notice</title><link>https://notice.example/two</link></item></channel></rss>",
  ),
  summary: {
    summarize: async () => {
      throw new Error("No AI permitted");
    },
  },
  email: {
    send: async () => {
      throw new Error("No email permitted");
    },
  },
});
const agent = request.agent(app);
let userId = "",
  otherId = "";
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  const address = `journal-manager-${randomUUID()}@example.com`;
  userId = (
    await db.user.create({
      data: { email: address, passwordHash: await Bun.password.hash("Password123456") },
    })
  ).id;
  otherId = (
    await db.user.create({
      data: { email: `other-${randomUUID()}@example.com`, passwordHash: "unused" },
    })
  ).id;
  await agent.post("/auth/login").send({ email: address, password: "Password123456" }).expect(200);
});
afterEach(async () => {
  const keys = await redis.keys(`dailybrief:workflow:${userId}:*`);
  if (keys.length) await redis.del(keys);
  await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
});
const source = (owner = userId, url = `https://notice.example/${randomUUID()}`) =>
  db.source.create({
    data: { userId: owner, url, type: "RSS", articleLinkSelector: "a.primarydoc" },
  });
function counts(values: Record<string, number>) {
  return {
    articles: [
      {
        title: "Erreur",
        url: null,
        publishedAt: null,
        description: null,
        resolutionError: "Notice inaccessible",
      },
    ],
    journals: Object.entries(values).map(([domain, count]) => ({
      domain,
      count,
      enabled: false,
      email: null,
      hasCredentials: false,
      authenticationSupported: false,
    })),
  };
}

test("requires authentication and creates normalized, disabled journals without ownership spoofing or duplicates", async () => {
  await request(app).get("/journals").expect(401);
  await request(app).post("/journals").send({ domain: "paper.example" }).expect(401);
  await request(app).delete("/journals/paper.example").expect(401);
  const added = await agent
    .post("/journals")
    .send({ domain: "HTTPS://WWW.PAPER.EXAMPLE/story" })
    .expect(201);
  assert.deepEqual(added.body, {
    domain: "www.paper.example",
    enabled: false,
    email: null,
    hasCredentials: false,
    authenticationSupported: false,
    loginConfig: null,
  });
  await agent.post("/journals").send({ domain: "www.paper.example." }).expect(409);
  await agent.post("/journals").send({ domain: "paper.example", userId: otherId }).expect(400);
  await agent.post("/journals").send({ domain: "paper.example", enabled: true }).expect(400);
  for (const domain of [
    "localhost",
    "127.0.0.1",
    "internal.local",
    "https://reader:secret@paper.example",
    "file://paper.example",
    "-bad.example",
    "foo..example",
    "paper.example:1234",
  ])
    await agent.post("/journals").send({ domain }).expect(400);
  // Exact hosts remain independent.
  await agent.post("/journals").send({ domain: "paper.example" }).expect(201);
  assert.equal((await agent.get("/journals").expect(200)).body.journals.length, 2);
});

test("lists only owned journals, sums the latest per-source counts and excludes stale or removed sources", async () => {
  for (const domain of ["a.example", "b.example", "c.example", "manual.example"])
    await journals.ensure(userId, domain);
  await journals.ensure(otherId, "private.example");
  const one = await source(),
    two = await source(),
    foreign = await source(otherId);
  await recordJournalInventory(
    db,
    userId,
    one,
    counts({ "a.example": 2, "b.example": 2, "c.example": 2 }),
  );
  await recordJournalInventory(db, userId, two, counts({ "a.example": 1 }));
  await recordJournalInventory(
    db,
    otherId,
    foreign,
    counts({ "a.example": 99, "private.example": 99 }),
  );
  const password = cipher.encrypt("private-secret", userId, "a.example");
  await db.journalAccess.update({
    where: { userId_domain: { userId, domain: "a.example" } },
    data: { enabled: true, email: "reader@example.com", encryptedPassword: password },
  });
  const response = await agent.get("/journals").expect(200);
  assert.deepEqual(
    response.body.journals.map((j: { domain: string; count: number }) => [j.domain, j.count]),
    [
      ["a.example", 3],
      ["b.example", 2],
      ["c.example", 2],
      ["manual.example", 0],
    ],
  );
  assert.equal(response.body.unresolvedCount, 2);
  assert(response.body.lastInventoriedAt);
  assert(!response.text.includes(password));
  assert(!response.text.includes("private-secret"));
  assert(!response.text.includes("private.example"));
  await recordJournalInventory(db, userId, one, counts({ "b.example": 4 }));
  const replaced = (await agent.get("/journals").expect(200)).body;
  assert.deepEqual(
    replaced.journals
      .slice(0, 2)
      .map((j: { domain: string; count: number }) => [j.domain, j.count]),
    [
      ["b.example", 4],
      ["a.example", 1],
    ],
  );
  await db.source.update({ where: { id: one.id }, data: { articleLinkSelector: "a.changed" } });
  await recordJournalInventory(db, userId, one, counts({ "b.example": 100 }));
  assert.equal(
    (await agent.get("/journals")).body.journals.find(
      (j: { domain: string }) => j.domain === "b.example",
    ).count,
    0,
  );
  await db.source.delete({ where: { id: two.id } });
  assert.equal((await agent.get("/journals")).body.lastInventoriedAt, null);
});

test("changing a domain resets access, preserves unchanged domains and cannot overwrite another configuration", async () => {
  const password = cipher.encrypt("private-secret", userId, "paper.example");
  await db.journalAccess.create({
    data: {
      userId,
      domain: "paper.example",
      enabled: true,
      email: "reader@example.com",
      encryptedPassword: password,
      ...loginConfig,
    },
  });
  await agent.patch("/journals/paper.example").send({ domain: "PAPER.EXAMPLE" }).expect(200);
  assert.equal(
    (
      await db.journalAccess.findUniqueOrThrow({
        where: { userId_domain: { userId, domain: "paper.example" } },
      })
    ).encryptedPassword,
    password,
  );
  await journals.ensure(userId, "duplicate.example");
  await agent.patch("/journals/paper.example").send({ domain: "duplicate.example" }).expect(409);
  await agent
    .patch("/journals/paper.example")
    .send({ domain: "new.example", enabled: true })
    .expect(400);
  const changed = await agent
    .patch("/journals/paper.example")
    .send({ domain: "www.paper.example" })
    .expect(200);
  assert.deepEqual(changed.body, {
    domain: "www.paper.example",
    enabled: false,
    email: null,
    hasCredentials: false,
    authenticationSupported: false,
    loginConfig: null,
  });
  const stored = await db.journalAccess.findUniqueOrThrow({
    where: { userId_domain: { userId, domain: "www.paper.example" } },
  });
  assert.equal(stored.encryptedPassword, null);
  assert.equal(stored.passwordSelector, null);
  await journals.ensure(otherId, "foreign.example");
  await agent.patch("/journals/foreign.example").send({ domain: "stolen.example" }).expect(404);
  await agent.delete("/journals/foreign.example").expect(404);
  assert(
    await db.journalAccess.findUnique({
      where: { userId_domain: { userId: otherId, domain: "foreign.example" } },
    }),
  );
});

test("workflow records current counts; deletion preserves articles and newsletters and rediscovery defaults to disabled", async () => {
  const feed = await source();
  const article = await db.article.create({
    data: {
      userId,
      sourceId: feed.id,
      title: "Existant",
      url: "https://notice.example/one",
      contentHash: randomUUID(),
      fingerprint: randomUUID(),
      summary: "Résumé existant",
    },
  });
  await db.newsletter.create({
    data: {
      userId,
      recipientEmail: "reader@example.com",
      subject: "Envoyée",
      status: "SENT",
      articles: { create: { articleId: article.id } },
    },
  });
  const articles = await db.article.findMany({ where: { userId } }),
    newsletters = await db.newsletter.findMany({ where: { userId } });
  await agent.post(`/sources/${feed.id}/workflow`).send({}).expect(200);
  let listed = (await agent.get("/journals")).body.journals;
  assert.equal(listed[0].count, 2);
  assert.equal(listed[0].enabled, false);
  await agent.patch("/journals/paper.example").send({ enabled: true }).expect(200);
  await agent.delete("/journals/paper.example").expect(204);
  await agent.delete("/journals/paper.example").expect(404);
  assert.deepEqual((await agent.get("/journals")).body.journals, []);
  await agent.post(`/sources/${feed.id}/workflow`).send({}).expect(200);
  listed = (await agent.get("/journals")).body.journals;
  assert.equal(listed[0].count, 2);
  assert.equal(listed[0].enabled, false);
  assert.deepEqual(await db.article.findMany({ where: { userId } }), articles);
  assert.deepEqual(await db.newsletter.findMany({ where: { userId } }), newsletters);
});
