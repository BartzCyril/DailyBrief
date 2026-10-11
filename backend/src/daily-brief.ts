import { Prisma } from "@prisma/client";
import type { DailyBriefSnapshot, DailyBriefContent } from "@dailybrief/shared";
import type { Db } from "./db";
import type { SummaryProvider } from "./ai";
import { AppError } from "./errors";
import { JournalAccessService, journalAccessVersion } from "./journal-access";
import { reportProgress, type ProgressObserver } from "./progress";
import { ArticleContentService } from "./article-content";

type BriefRow = Awaited<ReturnType<Db["dailyBrief"]["findFirstOrThrow"]>>;
export function briefSnapshot(brief: BriefRow): DailyBriefSnapshot {
  return {
    id: brief.id,
    runId: brief.runId,
    date: brief.date,
    timezone: brief.timezone,
    status: brief.status as DailyBriefSnapshot["status"],
    content: brief.content as DailyBriefContent | null,
    articleCount: brief.articleCount,
    error: brief.error,
    createdAt: brief.createdAt.toISOString(),
  };
}
export async function latestBrief(db: Db, userId: string) {
  const brief = await db.dailyBrief.findFirst({
    where: { userId, status: { in: ["READY", "EMPTY", "FAILED"] } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });
  return brief ? briefSnapshot(brief) : null;
}

// The final queue job reads summaries from PostgreSQL, never from the browser or Redis.
export class DailyBriefService {
  constructor(
    private db: Db,
    private provider: SummaryProvider,
    private journals = new JournalAccessService(db, new ArticleContentService()),
  ) {}
  async run(
    userId: string,
    runId: string,
    observer?: ProgressObserver,
    assertOwned: () => Promise<void> = async () => {},
  ): Promise<DailyBriefSnapshot> {
    const run = await this.db.dailyBriefRun.findFirst({ where: { id: runId, userId } });
    if (!run?.periodStart || !run.periodEnd || !run.briefDate || !run.timezone)
      throw new AppError(
        409,
        "La période de la collecte est indisponible.",
        "BRIEF_PERIOD_MISSING",
      );
    const existing = await this.db.dailyBrief.findUnique({ where: { runId } });
    if (existing && ["READY", "EMPTY"].includes(existing.status)) return briefSnapshot(existing);
    if (run.finishedAt)
      throw new AppError(409, "Cette collecte est déjà terminée.", "COLLECTION_FINISHED");
    await assertOwned();
    const row = await this.db.dailyBrief.upsert({
      where: { runId },
      create: { userId, runId, date: run.briefDate, timezone: run.timezone },
      update: { status: "GENERATING", error: null },
    });
    const report = (status: "running" | "completed" | "failed" | "skipped", message: string) =>
      reportProgress(observer, { stage: "brief", status, message });
    try {
      const candidates = await this.db.article.findMany({
        where: {
          userId,
          publishedAt: { gte: run.periodStart, lt: run.periodEnd },
          relevant: true,
          summary: { not: null },
          summarizedAt: { not: null },
          contentFetchedAt: { not: null },
          source: { enabled: true },
        },
        include: { source: true },
        orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
      });
      const articles: typeof candidates = [];
      for (const article of candidates) {
        if (article.source.type === "RSS" && article.source.articleLinkSelector) {
          if (
            !article.contentUrl ||
            article.contentLinkSelector !== article.source.articleLinkSelector
          )
            continue;
          try {
            const access = await this.journals.assertAccessible(userId, article.contentUrl);
            if (journalAccessVersion(access) !== article.contentAccessVersion) continue;
          } catch {
            continue;
          }
        }
        articles.push(article);
      }
      if (!articles.length) {
        await assertOwned();
        const empty = await this.db.dailyBrief.update({
          where: { id: row.id },
          data: {
            status: "EMPTY",
            content: Prisma.DbNull,
            articleCount: 0,
            articleIds: [],
            error: null,
          },
        });
        report("skipped", "Aucun article pertinent disponible pour ce brief.");
        return briefSnapshot(empty);
      }
      report(
        "running",
        `Préparation du Daily Brief à partir de ${articles.length} articles pertinents.`,
      );
      if (!this.provider.generateBrief)
        throw new AppError(
          503,
          "La génération du Daily Brief n'est pas disponible.",
          "BRIEF_UNAVAILABLE",
        );
      const content = await this.provider.generateBrief(
        {
          date: run.briefDate,
          timezone: run.timezone,
          interestPrompt: run.interestPrompt ?? "",
          articles: articles.map((article) => ({
            id: article.id,
            title: article.summaryTitle ?? article.title,
            summary: article.summary!,
            keyPoints: article.keyPoints,
            url: article.contentUrl ?? article.url,
            publishedAt: article.publishedAt?.toISOString() ?? null,
          })),
        },
        (message) => report("running", message),
      );
      await assertOwned();
      // Do not publish a summary whose source/access was disabled while the AI was working.
      for (const article of articles) {
        const current = await this.db.article.findFirst({
          where: { id: article.id, userId, relevant: true, source: { enabled: true } },
          include: { source: true },
        });
        if (
          !current ||
          current.updatedAt.getTime() !== article.updatedAt.getTime() ||
          current.source.updatedAt.getTime() !== article.source.updatedAt.getTime()
        )
          throw new AppError(
            409,
            "Les articles ont changé pendant la génération du brief. Réessayez.",
            "BRIEF_INPUT_CHANGED",
          );
        if (
          article.source.type === "RSS" &&
          article.source.articleLinkSelector &&
          article.contentUrl
        ) {
          const access = await this.journals.assertAccessible(userId, article.contentUrl);
          if (journalAccessVersion(access) !== article.contentAccessVersion)
            throw new AppError(
              409,
              "L'accès au journal a changé pendant la génération du brief.",
              "BRIEF_INPUT_CHANGED",
            );
        }
      }
      const saved = await this.db.dailyBrief.update({
        where: { id: row.id },
        data: {
          status: "READY",
          content,
          articleCount: articles.length,
          articleIds: articles.map((article) => article.id),
          error: null,
        },
      });
      report("completed", "Daily Brief généré et sauvegardé.");
      return briefSnapshot(saved);
    } catch (error) {
      // A stale worker must leave the replacement worker's result intact.
      await assertOwned();
      const message =
        error instanceof AppError ? error.message : "La génération du Daily Brief a échoué.";
      await this.db.dailyBrief.update({
        where: { id: row.id },
        data: { status: "FAILED", error: message },
      });
      report("failed", message);
      throw error instanceof AppError ? error : new AppError(502, message, "BRIEF_FAILED");
    }
  }
}
