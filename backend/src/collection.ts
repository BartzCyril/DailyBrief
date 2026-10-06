import type { ArticlePreview, RunResult } from "@dailybrief/shared";
import type { Db } from "./db";
import { RssService } from "./rss";
import { ScrapingService } from "./scraping";
import { scrapingSchema } from "../../shared/src/scraping";
import { AppError } from "./errors";
import { reportProgress, type ProgressObserver } from "./progress";

export type CollectedArticle = ArticlePreview & { sourceId: string };
export type SourceResult = {
  sourceId: string;
  success: boolean;
  articles: CollectedArticle[];
  durationMs: number;
  error?: string;
};
export class SourceCollector {
  constructor(
    private db: Db,
    private rss: RssService,
    private scraping: ScrapingService,
  ) {}
  async collect(userId: string, observer?: ProgressObserver): Promise<SourceResult[]> {
    const sources = await this.db.source.findMany({
      where: { userId, enabled: true },
      orderBy: { createdAt: "asc" },
    });
    const results: SourceResult[] = [];
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
      try {
        const preview =
          source.type === "RSS"
            ? await this.rss.collect(source.url)
            : await this.scraping.collect(source.url, scrapingSchema.parse(source.scrapingConfig));
        results.push({
          sourceId: source.id,
          success: true,
          durationMs: Date.now() - start,
          articles: preview.articles.map((article) => ({ ...article, sourceId: source.id })),
        });
        reportProgress(observer, {
          stage: "source",
          status: "completed",
          message: `${label} : ${preview.articles.length} articles récupérés.`,
          completed: results.length,
          total: sources.length,
        });
      } catch (error) {
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
