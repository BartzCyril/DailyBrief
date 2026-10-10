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
const config = readConfig();
const db = createDb(config.DATABASE_URL);
const redis = createClient({ url: config.REDIS_URL });
redis.on("error", () => console.error("Redis connection error"));
await Promise.all([db.$connect(), redis.connect()]);
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
await collections.connection.ping();
const stopScheduler = startScheduler(db, {
  recover: () => collections.recover(),
  run: (userId, trigger) => collections.enqueue(userId, trigger),
});
const server = createApp(db, redis, config, {
  runner,
  articleContent,
  journalAccess: journals,
  collections,
}).listen(config.PORT, () => console.info(`DailyBrief listening on port ${config.PORT}`));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  stopScheduler();
  server.close();
  await collections.close();
  await Promise.all([db.$disconnect(), redis.quit()]);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
