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
import { SourceCollector, CollectionService, type CollectionRunner } from "./collection";
import { UserCollectionLock } from "./lock";
import { settingsRouter } from "./settings";
export function createApp(db: Db, redis: Redis, config: Config, services: { rss?: RssService; scraping?: ScrapingService; runner?: CollectionRunner } = {}) {
  const rss = services.rss ?? new RssService(); const scraping = services.scraping ?? new ScrapingService();
  const runner = services.runner ?? new CollectionService(db, new SourceCollector(db, rss, scraping), new UserCollectionLock(redis));
  const app = express();
  app.disable("x-powered-by");
  if (config.NODE_ENV === "production") app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true }));
  app.use((req, _res, next) => {
    const origin = req.get("origin");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin && origin !== config.FRONTEND_ORIGIN) {
      next(new AppError(403, "Origine non autorisée.", "INVALID_ORIGIN")); return;
    }
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.use(session({ store: new RedisStore({ client: redis, prefix: "dailybrief:session:" }), secret: config.SESSION_SECRET, name: config.SESSION_COOKIE_NAME, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production", maxAge: config.SESSION_MAX_AGE } }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/auth", authRouter(db, config));
  app.use("/sources", sourcesRouter(db, rss, scraping));
  app.use(settingsRouter(db, runner));
  app.use(errorHandler);
  return app;
}
