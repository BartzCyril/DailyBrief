import express from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import type { Redis } from "./redis";
import cors from "cors";
import helmet from "helmet";
import type { Db } from "./db";
import type { Config } from "./config";
import { authRouter } from "./auth";
import { AppError, errorHandler } from "./errors";
import { RssService } from "./rss";
import { sourcesRouter } from "./sources";
import { ScrapingService } from "./scraping";
import { SourceCollector, type CollectionRunner } from "./collection";
import { UserCollectionLock } from "./lock";
import { settingsRouter } from "./settings";
import { OllamaClient, OllamaSummaryProvider, type SummaryProvider } from "./ai";
import { aiRouter } from "./ai-routes";
import { DailyBriefPipelineService } from "./pipeline";
import { NewsletterEmailService, type NewsletterSender } from "./email";
import { ArticleContentService } from "./article-content";
import { sourceWorkflowRouter } from "./source-workflow";
import { journalAccessRouter, JournalSecretCipher, JournalAccessService } from "./journal-access";
import type { JournalLoginBrowser } from "./journal-login";
import { OllamaSelectorAnalysisProvider, type SelectorAnalysisProvider } from "./selector-analysis";
import { SelectorHelpService, type SelectorHelpSender } from "./selector-support";
import { selectorAssistanceRouter } from "./selector-assistance";
import type { JobsManager } from "./queue/jobs-manager";
export function createApp(
  db: Db,
  redis: Redis,
  config: Config,
  services: {
    rss?: RssService;
    scraping?: ScrapingService;
    runner?: CollectionRunner;
    collections?: JobsManager;
    summary?: SummaryProvider;
    email?: NewsletterSender;
    articleContent?: ArticleContentService;
    journalLogin?: JournalLoginBrowser;
    journalAccess?: JournalAccessService;
    selectorAnalysis?: SelectorAnalysisProvider;
    selectorHelp?: SelectorHelpService;
    selectorHelpSender?: SelectorHelpSender;
  } = {},
) {
  const rss = services.rss ?? new RssService();
  const scraping = services.scraping ?? new ScrapingService();
  const summary = services.summary ?? new OllamaSummaryProvider(config);
  const articleContent = services.articleContent ?? new ArticleContentService();
  const cipher = new JournalSecretCipher(config.JOURNAL_ENCRYPTION_KEY);
  const journals =
    services.journalAccess ??
    new JournalAccessService(db, articleContent, cipher, services.journalLogin);
  const runner =
    services.runner ??
    new DailyBriefPipelineService(
      db,
      new SourceCollector(db, rss, scraping, articleContent),
      new UserCollectionLock(redis),
      summary,
      services.email ?? new NewsletterEmailService(config),
      articleContent,
      journals,
    );
  const app = express();
  app.disable("x-powered-by");
  if (config.NODE_ENV === "production") app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true }));
  app.use((req, _res, next) => {
    const origin = req.get("origin");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      origin &&
      origin !== config.FRONTEND_ORIGIN
    ) {
      next(new AppError(403, "Origine non autorisée.", "INVALID_ORIGIN"));
      return;
    }
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.use(
    session({
      store: new RedisStore({ client: redis, prefix: "dailybrief:session:" }),
      secret: config.SESSION_SECRET,
      name: config.SESSION_COOKIE_NAME,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.NODE_ENV === "production",
        maxAge: config.SESSION_MAX_AGE,
      },
    }),
  );
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/auth", authRouter(db, config));
  app.use("/sources", sourcesRouter(db, rss, scraping));
  app.use(
    "/sources",
    sourceWorkflowRouter(db, redis, rss, scraping, articleContent, summary, journals),
  );
  app.use("/journals", journalAccessRouter(db, cipher, journals));
  app.use(settingsRouter(db, runner, services.collections));
  const aiClient = new OllamaClient(config);
  app.use("/ai", aiRouter(summary, aiClient));
  app.use(
    "/ai/selectors",
    selectorAssistanceRouter(
      db,
      services.selectorAnalysis ??
        new OllamaSelectorAnalysisProvider(config, { rss, client: aiClient }),
      services.selectorHelp ?? new SelectorHelpService(redis, config, services.selectorHelpSender),
    ),
  );
  app.use(errorHandler);
  return app;
}
