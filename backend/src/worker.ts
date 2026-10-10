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

const config = readConfig();
const db = createDb(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
redis.on("error", () => console.error("Redis connection error"));
await Promise.all([db.$connect(), redis.connect()]);
const manager = new JobsManager(db, config);
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
  (dispatch) =>
    new DailyBriefPipelineService(
      db,
      collector,
      new UserCollectionLock(redis, 30000),
      summary,
      new NewsletterEmailService(config),
      content,
      journals,
      dispatch,
    ),
  new ScrapingSummaryProcessor(db, summary, content, journals),
);
console.info(`DailyBrief workers ready: ${config.AI_CONCURRENCY} article job(s) at a time.`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await consumers.close();
  await manager.close();
  await Promise.all([db.$disconnect(), redis.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
