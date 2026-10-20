import { Queue } from "bullmq";
import type IORedis from "ioredis";
import type { Db } from "./db";

const queueNames = ["collections", "article-summaries"];
const validPrefix = /^[a-zA-Z0-9_-]+$/;

export async function historySnapshot(db: Db, redis: IORedis, prefix: string) {
  const namespaces = await db.dailyBriefRun.findMany({
    where: { queuePrefix: { not: null } },
    select: { queuePrefix: true },
    distinct: ["queuePrefix"],
  });
  const prefixes = [...new Set([prefix, ...namespaces.map((run) => run.queuePrefix!)])];
  if (prefixes.some((value) => !validPrefix.test(value)))
    throw new Error("Un préfixe de file enregistré est invalide ; aucune donnée supprimée.");
  await redis.ping();
  const [users, sources, settings, journalAccess, articles, newsletters, runs, briefs] =
    await Promise.all([
      db.user.count(),
      db.source.count(),
      db.dailyBriefSettings.count(),
      db.journalAccess.count(),
      db.article.count(),
      db.newsletter.count(),
      db.dailyBriefRun.count(),
      db.dailyBrief.count(),
    ]);
  return {
    prefixes,
    kept: { users, sources, settings, journalAccess },
    removed: { articles, newsletters, runs, briefs },
  };
}

async function clearActiveKeys(redis: IORedis, prefix: string) {
  // Scan rather than KEYS/FLUSHDB: sessions and other applications must survive.
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${prefix}:collection-active:*`,
      "COUNT",
      200,
    );
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
}

export async function resetHistory(db: Db, redis: IORedis, prefix: string) {
  const snapshot = await historySnapshot(db, redis, prefix);
  const queues = snapshot.prefixes.flatMap((namespace) =>
    queueNames.map((name) => new Queue(name, { connection: redis, prefix: namespace })),
  );
  try {
    // Stale active jobs can be purged, but live consumers must be stopped first.
    for (const queue of queues) {
      if ((await queue.getWorkers()).length)
        throw new Error(
          "Arrêtez l'API et tous les workers (npm run dev) avant de vider l'historique.",
        );
    }
    // Clean Redis first: a failure leaves SQL history available for a safe retry.
    for (const queue of queues) await queue.obliterate({ force: true });
    for (const namespace of snapshot.prefixes) await clearActiveKeys(redis, namespace);
    let cursor: string | undefined;
    for (;;) {
      const users = await db.user.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
        take: 200,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (users.length)
        await redis.del(...users.map((user) => `dailybrief:collection:user:${user.id}`));
      if (users.length < 200) break;
      cursor = users.at(-1)!.id;
    }
    // Explicit tables and one transaction: never cascade into accounts or sources.
    await db.$transaction([
      db.newsletterArticle.deleteMany(),
      db.dailyBrief.deleteMany(),
      db.dailyBriefRun.deleteMany(),
      db.newsletter.deleteMany(),
      db.article.deleteMany(),
      db.dailyBriefSettings.updateMany({ data: { lastCollectionAt: null } }),
    ]);
    return snapshot;
  } finally {
    await Promise.all(queues.map((queue) => queue.close()));
  }
}
