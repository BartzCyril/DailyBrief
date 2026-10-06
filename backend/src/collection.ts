import type { ArticlePreview } from "@dailybrief/shared";
import type { Db } from "./db";
import { RssService } from "./rss";
import { ScrapingService } from "./scraping";
import { scrapingSchema } from "../../shared/src/scraping";
import { AppError } from "./errors";

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
  async collect(userId: string): Promise<SourceResult[]> {
    const sources = await this.db.source.findMany({
      where: { userId, enabled: true },
      orderBy: { createdAt: "asc" },
    });
    const results: SourceResult[] = [];
    for (const source of sources) {
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
      } catch (error) {
        results.push({
          sourceId: source.id,
          success: false,
          durationMs: Date.now() - start,
          articles: [],
          error: error instanceof AppError ? error.message : "Échec de récupération de la source.",
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
  run(userId: string, trigger?: RunTrigger): Promise<unknown>;
}
