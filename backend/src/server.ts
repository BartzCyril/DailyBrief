import { createApp } from "./app";
import { createClient } from "redis";
import { readConfig } from "./config";
import { createDb } from "./db";
import { RssService } from "./rss";
import { ScrapingService } from "./scraping";
import { SourceCollector } from "./collection";
import { UserCollectionLock } from "./lock";
import { startScheduler } from "./scheduler";
import { DailyBriefPipelineService } from "./pipeline";
import { OllamaSummaryProvider } from "./ai";
import { NewsletterEmailService } from "./email";
import { ArticleContentService } from "./article-content";
import { JournalAccessService, JournalSecretCipher } from "./journal-access";
import { JobsManager } from "./queue/jobs-manager";
import { logger } from "./logger";
import { runService } from "./service-runtime";
await runService("backend", async (defer, fatal) => {
  const config = readConfig();
  const db = createDb(config.DATABASE_URL);
  defer(() => db.$disconnect());
  const redis = createClient({ url: config.REDIS_URL });
  defer(async () => {
    if (redis.isOpen) await redis.quit();
  });
  redis.on("error", (error) =>
    logger.error("redis.connection_failed", "Connexion Redis indisponible.", { error }),
  );
  await Promise.all([db.$connect(), redis.connect()]);
  logger.info("dependencies.ready", "Connexions PostgreSQL et Redis établies.");
  const articleContent = new ArticleContentService();
  const journals = new JournalAccessService(
    db,
    articleContent,
    new JournalSecretCipher(config.JOURNAL_ENCRYPTION_KEY),
  );
  const runner = new DailyBriefPipelineService(
    db,
    new SourceCollector(db, new RssService(), new ScrapingService(), articleContent),
    new UserCollectionLock(redis),
    new OllamaSummaryProvider(config),
    new NewsletterEmailService(config),
    articleContent,
    journals,
  );
  const collections = new JobsManager(db, config);
  defer(() => collections.close());
  await collections.connection.ping();
  const server = createApp(db, redis, config, {
    runner,
    articleContent,
    journalAccess: journals,
    collections,
  }).listen(config.PORT);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (error) => void fatal("http.server_failed", error));
  defer(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const stopScheduler = startScheduler(db, {
    recover: () => collections.recover(),
    run: (userId, trigger) => collections.enqueue(userId, trigger),
  });
  defer(stopScheduler);
  logger.info("http.ready", "API prête à recevoir les requêtes.", { port: config.PORT });
});
