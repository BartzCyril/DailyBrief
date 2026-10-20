import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import { Pool } from "pg";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { createDb, type Db } from "../src/db";
import { historySnapshot, resetHistory } from "../src/reset-history";

describe("history reset on an isolated database", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const database = `reset_history_${suffix}_test`;
  const prefix = `reset-${suffix}`;
  const oldPrefix = `${prefix}-old`;
  const foreignPrefix = `${prefix}-foreign`;
  const sessionKey = `sess:${suffix}`;
  let databaseUrl: string;
  let admin: Pool;
  let sql: Pool;
  let db: Db;
  let redis: IORedis;
  let queues: Queue[] = [];
  let users: Awaited<ReturnType<Db["user"]["findMany"]>>;
  let sources: Awaited<ReturnType<Db["source"]["findMany"]>>;
  let settings: Awaited<ReturnType<Db["dailyBriefSettings"]["findMany"]>>;
  let journals: Awaited<ReturnType<Db["journalAccess"]["findMany"]>>;

  const runScript = (script: string, ...args: string[]) =>
    spawnSync("npm", ["run", script, ...(args.length ? ["--", ...args] : [])], {
      cwd: resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
        DATABASE_URL: databaseUrl,
        QUEUE_PREFIX: prefix,
        npm_config_update_notifier: "false",
      },
      encoding: "utf8",
      timeout: 30000,
    });
  const command = (...args: string[]) => runScript("db:reset-history", ...args);

  beforeAll(async () => {
    const target = process.env.TEST_DATABASE_URL;
    if (!target || !new URL(target).pathname.endsWith("_test"))
      throw new Error("Use a dedicated _test database");
    admin = new Pool({ connectionString: target });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(target);
    url.pathname = `/${database}`;
    databaseUrl = url.href;
    const migration = spawnSync(process.execPath, ["scripts/migrate.ts"], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      timeout: 30000,
    });
    if (migration.status !== 0) throw new Error(migration.stderr || "Test migrations failed");
    sql = new Pool({ connectionString: databaseUrl });
    db = createDb(databaseUrl);
    redis = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
      maxRetriesPerRequest: 1,
    });
    redis.on("error", () => {});
    for (const [index, namespace] of [prefix, oldPrefix].entries()) {
      const user = await db.user.create({
        data: { email: `reset-${index}@example.com`, passwordHash: "fixture-hash" },
      });
      const source = await db.source.create({
        data: {
          userId: user.id,
          url: `https://example.com/${index}`,
          type: "RSS",
          articleLinkSelector: "a.article",
          enabled: index === 0,
        },
      });
      await db.dailyBriefSettings.create({
        data: {
          userId: user.id,
          collectionEnabled: true,
          collectionTime: "12:00",
          interestPrompt: "Suivre React.",
          lastCollectionAt: new Date("2026-10-20T10:00:00Z"),
          nextCollectionAt: new Date("2030-10-20T10:00:00Z"),
        },
      });
      await db.journalAccess.create({
        data: {
          userId: user.id,
          domain: "example.com",
          enabled: true,
          encryptedPassword: "encrypted-test-fixture",
          articleContentSelector: "article",
        },
      });
      const article = await db.article.create({
        data: {
          userId: user.id,
          sourceId: source.id,
          title: "Article",
          content: "Texte complet",
          summary: "Résumé",
          summaryTitle: "Titre du résumé",
          keyPoints: ["Point clé"],
          contentHash: `hash-${index}`,
          fingerprint: `fingerprint-${index}`,
        },
      });
      await db.newsletter.create({
        data: {
          userId: user.id,
          recipientEmail: user.email,
          subject: "Newsletter",
          status: "SENT",
          articles: { create: { articleId: article.id } },
        },
      });
      const run = await db.dailyBriefRun.create({
        data: { userId: user.id, queuePrefix: namespace, queueJobId: `job-${index}` },
      });
      await db.dailyBrief.create({
        data: { userId: user.id, runId: run.id, date: "2026-10-20", timezone: "Europe/Paris" },
      });
      const collection = new Queue("collections", { connection: redis, prefix: namespace });
      const summaries = new Queue("article-summaries", { connection: redis, prefix: namespace });
      queues.push(collection, summaries);
      await collection.add("collect-sources", { userId: user.id, runId: run.id });
      await summaries.add("summary", { articleId: article.id }, { delay: 60000 });
      await redis.set(`${namespace}:collection-active:${user.id}`, "job");
      await redis.set(`${namespace}:collection-active:${user.id}:enqueue`, "mutex");
      await redis.set(`dailybrief:collection:user:${user.id}`, "stale-lock");
    }
    const foreign = new Queue("collections", { connection: redis, prefix: foreignPrefix });
    queues.push(foreign);
    await foreign.add("unrelated-job", {});
    await redis.set(sessionKey, "session-to-keep");
    await redis.set(`dailybrief:collection:user:unrelated-${suffix}`, "foreign-lock");
    users = await db.user.findMany();
    sources = await db.source.findMany();
    settings = await db.dailyBriefSettings.findMany();
    journals = await db.journalAccess.findMany();
  }, 60000);

  afterAll(async () => {
    await Promise.all(queues.map((queue) => queue.close()));
    if (redis) {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
      await redis.del(sessionKey, `dailybrief:collection:user:unrelated-${suffix}`);
      for (const user of users ?? []) await redis.del(`dailybrief:collection:user:${user.id}`);
      redis.disconnect();
    }
    await db?.$disconnect();
    await sql?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
    }
  });

  test("default CLI preview does not modify SQL or Redis", async () => {
    const keys = (await redis.keys(`${prefix}*`)).sort();
    const result = command();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Aucune donnée modifiée");
    expect(result.stdout).toContain("npm run db:reset-history:confirm");
    expect(result.stdout).toContain(oldPrefix);
    expect(await db.article.count()).toBe(2);
    expect((await redis.keys(`${prefix}*`)).sort()).toEqual(keys);
  }, 30000);

  test("a live worker blocks deletion before SQL or jobs are removed", async () => {
    const connection = redis.duplicate({ maxRetriesPerRequest: null });
    const worker = new Worker("collections", async () => {}, {
      connection,
      prefix,
      autorun: false,
    });
    try {
      await worker.waitUntilReady();
      await expect(resetHistory(db, redis, prefix)).rejects.toThrow("Arrêtez l'API");
      expect(await db.article.count()).toBe(2);
      expect(await queues[0]!.getWaitingCount()).toBe(1);
    } finally {
      await worker.close();
      connection.disconnect();
    }
  });

  test("SQL deletion rolls back completely when a table cannot be cleared", async () => {
    await sql.query(`CREATE FUNCTION reject_reset() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'reset test failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_reset BEFORE DELETE ON "Article"
      FOR EACH ROW EXECUTE FUNCTION reject_reset()`);
    try {
      await expect(resetHistory(db, redis, prefix)).rejects.toThrow("reset test failure");
      expect(await db.article.count()).toBe(2);
      expect(await db.newsletter.count()).toBe(2);
      expect(await db.newsletterArticle.count()).toBe(2);
      expect(await db.dailyBriefRun.count()).toBe(2);
      expect(await db.dailyBrief.count()).toBe(2);
      expect(await db.dailyBriefSettings.findMany()).toEqual(settings);
    } finally {
      await sql.query('DROP TRIGGER reject_reset ON "Article"; DROP FUNCTION reject_reset()');
    }
  });

  test("confirmed CLI clears all history and associated namespaces while retaining config and sessions", async () => {
    // Include an interrupted active job left by a stopped worker.
    const connection = redis.duplicate({ maxRetriesPerRequest: null });
    const worker = new Worker("collections", async () => {}, {
      connection,
      prefix,
      autorun: false,
    });
    await queues[0]!.add("interrupted", {});
    await worker.getNextJob("test-token");
    await worker.close(true);
    connection.disconnect();
    // Let Redis observe socket closure before the synchronous CLI child blocks
    // this process's event loop. A stopped process has no remaining clients.
    for (let attempt = 0; (await queues[0]!.getWorkers()).length; attempt++) {
      if (attempt >= 50) throw new Error("Test worker did not disconnect");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // No forwarded arguments: confirmation is part of the package script itself.
    const result = runScript("db:reset-history:confirm");
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Historique vidé");
    for (const count of await Promise.all([
      db.article.count(),
      db.newsletter.count(),
      db.newsletterArticle.count(),
      db.dailyBriefRun.count(),
      db.dailyBrief.count(),
    ]))
      expect(count).toBe(0);
    expect(await db.user.findMany()).toEqual(users);
    expect(await db.source.findMany()).toEqual(sources);
    expect(await db.journalAccess.findMany()).toEqual(journals);
    for (const setting of await db.dailyBriefSettings.findMany()) {
      const original = settings.find((value) => value.id === setting.id)!;
      expect(setting).toEqual({
        ...original,
        lastCollectionAt: null,
        updatedAt: setting.updatedAt,
      });
    }
    for (const namespace of [prefix, oldPrefix])
      expect(await redis.keys(`${namespace}:*`)).toEqual([]);
    for (const user of users)
      expect(await redis.exists(`dailybrief:collection:user:${user.id}`)).toBe(0);
    expect(await redis.get(sessionKey)).toBe("session-to-keep");
    expect(await redis.get(`dailybrief:collection:user:unrelated-${suffix}`)).toBe("foreign-lock");
    expect(await queues.at(-1)!.getWaitingCount()).toBe(1);
  }, 30000);

  test("an empty reset can be repeated and conflicting flags are rejected", async () => {
    expect((await resetHistory(db, redis, prefix)).removed).toEqual({
      articles: 0,
      newsletters: 0,
      runs: 0,
      briefs: 0,
    });
    expect(await db.user.count()).toBe(2);
    expect(command("--yes", "--dry-run").status).toBe(1);
    expect((await historySnapshot(db, redis, prefix)).kept.sources).toBe(2);
  }, 30000);
});
