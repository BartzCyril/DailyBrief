import type { ArticlePreview, RunResult } from "@dailybrief/shared";
import type { Db } from "./db";
import { RssService } from "./rss";
import { ScrapingService } from "./scraping";
import { scrapingSchema } from "../../shared/src/scraping";
import { AppError } from "./errors";
import { reportProgress, type ProgressObserver } from "./progress";
import { ArticleContentService } from "./article-content";
import { JournalAccessService } from "./journal-access";
import { recordJournalInventory } from "./journal-inventory";
import { filterRecentArticles, type RecentArticleWindow } from "./recent-articles";
import { logger } from "./logger";

export type CollectedArticle = ArticlePreview & { sourceId: string };
export type SourceResult = {
  sourceId: string;
  success: boolean;
  articles: CollectedArticle[];
  durationMs: number;
  error?: string;
  warnings?: string[];
};
export class SourceCollector {
  constructor(
    private db: Db,
    private rss: RssService,
    private scraping: ScrapingService,
    private articleContent = new ArticleContentService(),
  ) {}
  async collect(
    userId: string,
    observer?: ProgressObserver,
    window?: RecentArticleWindow,
  ): Promise<SourceResult[]> {
    const sources = await this.db.source.findMany({
      where: { userId, enabled: true },
      orderBy: { createdAt: "asc" },
    });
    const results: SourceResult[] = [];
    logger.info("sources.started", "Récupération des sources actives.", {
      userId,
      sources: sources.length,
    });
    for (const source of sources) {
      const label = `${source.type} · ${new URL(source.url).hostname}`;
      reportProgress(observer, {
        stage: "source",
        status: "running",
        message: `Récupération : ${label}.`,
        completed: results.length,
        total: sources.length,
      });
      const start = Date.now();
      logger.debug("source.started", "Lecture d'une source.", {
        userId,
        sourceId: source.id,
        type: source.type,
        domain: new URL(source.url).hostname,
      });
      try {
        const options = window ? { window, newestFirst: source.newestFirst } : undefined;
        const preview =
          source.type === "RSS"
            ? await this.rss.collect(source.url, Boolean(source.articleLinkSelector), options)
            : await this.scraping.collect(
                source.url,
                scrapingSchema.parse(source.scrapingConfig),
                options,
              );
        // Also enforce the boundary for injected collectors and legacy service implementations.
        if (window) {
          const recent = filterRecentArticles(preview.articles, window);
          preview.articles = recent.articles;
          preview.warnings = [...new Set([...(preview.warnings ?? []), ...recent.warnings])];
        }
        if (source.type === "RSS" && source.articleLinkSelector) {
          const inventory = await new JournalAccessService(this.db, this.articleContent).inventory(
            userId,
            preview.articles,
            source.articleLinkSelector,
          );
          preview.articles = inventory.articles;
          await recordJournalInventory(this.db, userId, source, inventory);
          for (const journal of inventory.journals)
            reportProgress(observer, {
              stage: "source",
              status: "completed",
              message: `${journal.domain} : ${journal.count} articles (${journal.enabled ? "activé" : "désactivé"}).`,
            });
          for (const article of inventory.articles.filter((item) => item.resolutionError))
            reportProgress(observer, {
              stage: "source",
              status: "failed",
              message: `${article.title} : ${article.resolutionError}`,
            });
        }
        results.push({
          sourceId: source.id,
          success: true,
          durationMs: Date.now() - start,
          articles: preview.articles.map((article) => ({ ...article, sourceId: source.id })),
          ...(preview.warnings?.length ? { warnings: preview.warnings } : {}),
        });
        logger.info("source.completed", "Source récupérée.", {
          userId,
          sourceId: source.id,
          articles: preview.articles.length,
          durationMs: Date.now() - start,
        });
        for (const warning of preview.warnings ?? [])
          reportProgress(observer, {
            stage: "source",
            status: "completed",
            message: `${label} : ${warning}`,
          });
        reportProgress(observer, {
          stage: "source",
          status: "completed",
          message: `${label} : ${preview.articles.length} articles récupérés.`,
          completed: results.length,
          total: sources.length,
        });
      } catch (error) {
        logger.error(
          "source.failed",
          "La récupération d'une source a échoué ; les autres sources continuent.",
          { userId, sourceId: source.id, durationMs: Date.now() - start, error },
        );
        const message =
          error instanceof AppError ? error.message : "Échec de récupération de la source.";
        results.push({
          sourceId: source.id,
          success: false,
          durationMs: Date.now() - start,
          articles: [],
          error: message,
        });
        reportProgress(observer, {
          stage: "source",
          status: "failed",
          message: `${label} : ${message}`,
          completed: results.length,
          total: sources.length,
        });
      }
    }
    return results;
  }
}
export async function getSettings(db: Db, userId: string) {
  return db.dailyBriefSettings.upsert({ where: { userId }, create: { userId }, update: {} });
}
export type RunTrigger = "manual" | "scheduled";
export interface CollectionRunner {
  run(userId: string, trigger?: RunTrigger, observer?: ProgressObserver): Promise<RunResult>;
}
