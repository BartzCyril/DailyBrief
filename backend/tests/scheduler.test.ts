import { DailyBriefPipelineService } from "../src/pipeline";
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { nextCollection, settingsSchema } from "../src/schedule";
import { UserCollectionLock } from "../src/lock";
import { RssService } from "../src/rss";
import { ScrapingService } from "../src/scraping";
import { SourceCollector, getSettings } from "../src/collection";
import { runDueCollections } from "../src/scheduler";
import { createApp } from "../src/app";
import { config, db, redis, connect, disconnect } from "./helpers";
test("daily schedule follows Paris summer/winter offsets", () => {
  expect(nextCollection("07:30", "Europe/Paris", new Date("2026-07-01T00:00Z")).toISOString()).toBe(
    "2026-07-01T05:30:00.000Z",
  );
  expect(nextCollection("07:30", "Europe/Paris", new Date("2026-12-01T00:00Z")).toISOString()).toBe(
    "2026-12-01T06:30:00.000Z",
  );
});
test("DST gaps shift forward and overlaps run once", () => {
  expect(nextCollection("02:30", "Europe/Paris", new Date("2026-03-29T00:00Z")).toISOString()).toBe(
    "2026-03-29T01:30:00.000Z",
  );
  expect(nextCollection("02:30", "Europe/Paris", new Date("2026-10-25T00:35Z")).toISOString()).toBe(
    "2026-10-26T01:30:00.000Z",
  );
});
test("validates settings and forbids ownership input", () => {
  for (const input of [
    { collectionTime: "25:00" },
    { timezone: "invalid" },
    { collectionEnabled: "true" },
    { userId: "other" },
  ])
    expect(settingsSchema.safeParse(input).success).toBe(false);
});
describe("collection settings, source isolation and Redis lock", () => {
  const email = `scheduler-${randomUUID()}@example.com`;
  const otherEmail = `disabled-${randomUUID()}@example.com`;
  let userId = "";
  let otherId = "";
  const rss = new RssService(async (url) => {
    if (url.endsWith("broken")) throw new Error("Source failure");
    return "<rss><channel><item><title>Test</title><link>https://example.com/item</link></item></channel></rss>";
  });
  const collector = new SourceCollector(db, rss, new ScrapingService());
  const runner = new DailyBriefPipelineService(
    db,
    collector,
    new UserCollectionLock(redis),
    {
      summarize: async (input) => ({
        title: input.title,
        summary: input.content,
        keyPoints: ["Point"],
      }),
    },
    { send: async () => {} },
  );
  const app = createApp(db, redis, config, { rss, runner });
  const agent = request.agent(app);
  beforeAll(async () => {
    await connect();
    const user = await db.user.create({
      data: { email, passwordHash: await Bun.password.hash("Password123456") },
    });
    userId = user.id;
    const other = await db.user.create({ data: { email: otherEmail, passwordHash: "unused" } });
    otherId = other.id;
    await db.source.createMany({
      data: [
        { userId, url: "https://example.com/feed", type: "RSS" },
        { userId, url: "https://example.com/broken", type: "RSS" },
        { userId, url: "https://example.com/off", type: "RSS", enabled: false },
        { userId: otherId, url: "https://example.com/private", type: "RSS" },
      ],
    });
    await agent.post("/auth/login").send({ email, password: "Password123456" });
  });
  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { in: [email, otherEmail] } } });
    await disconnect();
  });
  test("creates safe defaults and enables/changes/disables schedule", async () => {
    const defaults = await agent.get("/settings/dailybrief");
    expect(defaults.body.collectionEnabled).toBe(false);
    expect(defaults.body.timezone).toBe("Europe/Paris");
    const enabled = await agent
      .patch("/settings/dailybrief")
      .send({ collectionEnabled: true, collectionTime: "08:45", timezone: "America/New_York" });
    expect(enabled.status).toBe(200);
    expect(enabled.body.nextCollectionAt).not.toBeNull();
    expect(enabled.body.collectionTime).toBe("08:45");
    const disabled = await agent.patch("/settings/dailybrief").send({ collectionEnabled: false });
    expect(disabled.body.nextCollectionAt).toBeNull();
    expect((await request(app).get("/settings/dailybrief")).status).toBe(401);
  });
  test("collects only enabled owned sources and isolates errors", async () => {
    const sources = await collector.collect(userId);
    expect(sources).toHaveLength(2);
    expect(sources.filter((source) => source.success)).toHaveLength(1);
    expect(sources.flatMap((source) => source.articles)).toHaveLength(1);
  });
  test("Redis prevents concurrent work and releases only its own token", async () => {
    const key = `dailybrief:collection:user:${userId}`;
    await redis.set(key, "existing", { PX: 10000 });
    await expect(runner.run(userId)).rejects.toThrow("déjà en cours");
    expect(await redis.get(key)).toBe("existing");
    await redis.del(key);
    await runner.run(userId);
    expect(await redis.get(key)).toBeNull();
  });
  test("manual collection preserves daily schedule and updates dashboard", async () => {
    await agent.patch("/settings/dailybrief").send({ collectionEnabled: true });
    const before = await getSettings(db, userId);
    const result = await agent.post("/collection/run").send({});
    expect(result.status).toBe(200);
    expect(result.body.sourcesFailed).toBe(1);
    const after = await getSettings(db, userId);
    expect(after.nextCollectionAt?.toISOString()).toBe(before.nextCollectionAt?.toISOString());
    expect(after.lastCollectionAt).not.toBeNull();
    const dashboard = await agent.get("/dashboard");
    expect(dashboard.body.sources).toEqual({ total: 3, rss: 3, scraping: 0, enabled: 2 });
    expect(
      (await agent.post("/collection/run").send({ recipientEmail: "attacker@example.com" })).status,
    ).toBe(400);
  });
  test("scheduler runs due accounts and skips disabled accounts", async () => {
    await db.dailyBriefSettings.update({
      where: { userId },
      data: { collectionEnabled: true, nextCollectionAt: new Date(0) },
    });
    await getSettings(db, otherId);
    await db.dailyBriefSettings.update({
      where: { userId: otherId },
      data: { collectionEnabled: false, nextCollectionAt: new Date(0) },
    });
    const called: string[] = [];
    await runDueCollections(db, {
      run: async (id, trigger) => {
        called.push(id);
        expect(trigger).toBe("scheduled");
        return await runner.run(id, trigger);
      },
    });
    expect(called).toEqual([userId]);
    expect((await getSettings(db, userId)).nextCollectionAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
