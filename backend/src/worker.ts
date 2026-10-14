import { readConfig } from "./config";
import { createDb } from "./db";
import { createRedis } from "./redis";
import { SourceCollector } from "./collection";
import { RssService } from "./rss";
import { ScrapingService } from "./scraping";
import { ArticleContentService } from "./article-content";
import { JournalAccessService, JournalSecretCipher } from "./journal-access";
import { OllamaSummaryProvider } from "./ai";
import { NewsletterEmailService } from "./email";
import { DailyBriefPipelineService } from "./pipeline";
import { UserCollectionLock } from "./lock";
import { JobsManager } from "./queue/jobs-manager";
import { startConsumers } from "./queue/consumers";
import { ScrapingSummaryProcessor } from "./queue/scraping-summary";
import { logger } from "./logger";
import { runService } from "./service-runtime";
import { startWorkerHeartbeat } from "./worker-health";

await runService("consumers", async (defer) => {
  const config = readConfig();
  const db = createDb(config.DATABASE_URL);
  defer(() => db.$disconnect());
  const redis = createRedis(config.REDIS_URL);
  defer(async () => {
    if (redis.isOpen) await redis.quit();
  });
  redis.on("error", (error) =>
    logger.error("redis.connection_failed", "Connexion Redis indisponible.", { error }),
  );
  await Promise.all([db.$connect(), redis.connect()]);
  logger.info("dependencies.ready", "Connexions PostgreSQL et Redis établies.");
  const manager = new JobsManager(db, config);
  defer(() => manager.close());
  const content = new ArticleContentService();
  const journals = new JournalAccessService(
    db,
    content,
    new JournalSecretCipher(config.JOURNAL_ENCRYPTION_KEY),
  );
  const summary = new OllamaSummaryProvider(config);
  const collector = new SourceCollector(db, new RssService(), new ScrapingService(), content);
  const consumers = await startConsumers(
    db,
    manager,
    (dispatch, finalize) =>
      new DailyBriefPipelineService(
        db,
        collector,
        new UserCollectionLock(redis, 30000),
        summary,
        new NewsletterEmailService(config),
        content,
        journals,
        dispatch,
        finalize,
      ),
    new ScrapingSummaryProcessor(db, summary, content, journals),
  );
  defer(() => consumers.close());
  if (process.env.WORKER_HEALTH_FILE)
    defer(await startWorkerHeartbeat(process.env.WORKER_HEALTH_FILE));
  logger.info("consumers.ready", "Consommateurs prêts.", {
    model: config.OLLAMA_MODEL,
    aiConcurrency: config.AI_CONCURRENCY,
    collectionConcurrency: config.COLLECTION_CONCURRENCY,
  });
});
