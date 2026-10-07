import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { WorkflowPreview, WorkflowSummaryEvent } from "@dailybrief/shared";
import type { Db } from "./db";
import type { Redis } from "./redis";
import type { RssService } from "./rss";
import type { ScrapingService } from "./scraping";
import type { ArticleContentService } from "./article-content";
import type { SummaryProvider } from "./ai";
import { requireAuth } from "./auth";
import { AppError } from "./errors";
import { scrapingSchema } from "../../shared/src/scraping";
import { startEventStream } from "./event-stream";
import { reportProgress } from "./progress";

const PREVIEW_TTL_SECONDS = 1800;
const previewKey = (userId: string, sourceId: string, id: string) =>
  `dailybrief:workflow:${userId}:${sourceId}:${id}`;

export function sourceWorkflowRouter(
  db: Db,
  redis: Redis,
  rss: RssService,
  scraping: ScrapingService,
  articleContent: ArticleContentService,
  summary: SummaryProvider,
) {
  const router = Router();
  router.use(requireAuth);
  async function ownedSource(userId: string, id: string) {
    const source = await db.source.findFirst({ where: { id, userId } });
    if (!source) throw new AppError(404, "Source introuvable.", "SOURCE_NOT_FOUND");
    return source;
  }
  router.post("/:sourceId/workflow", async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const userId = req.session.userId!;
    const source = await ownedSource(userId, String(req.params.sourceId));
    const collected =
      source.type === "RSS"
        ? await rss.collect(source.url)
        : await scraping.collect(source.url, scrapingSchema.parse(source.scrapingConfig));
    const preview: WorkflowPreview = {
      id: randomUUID(),
      source: { id: source.id, url: source.url, type: source.type },
      articles: collected.articles,
      warnings: collected.warnings,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
    };
    // Immutable temporary previews support independent tabs without touching production articles.
    await redis.set(previewKey(userId, source.id, preview.id), JSON.stringify(preview), {
      EX: PREVIEW_TTL_SECONDS,
    });
    res.json(preview);
  });
  router.post("/:sourceId/workflow/:workflowId/articles/:index/summarize", async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const userId = req.session.userId!;
    const source = await ownedSource(userId, String(req.params.sourceId));
    const workflowId = z.uuid().parse(req.params.workflowId);
    const index = z.coerce.number().int().min(0).parse(req.params.index);
    const cached = await redis.get(previewKey(userId, source.id, workflowId));
    const preview: WorkflowPreview | null = cached ? JSON.parse(cached) : null;
    if (!preview || preview.id !== workflowId)
      throw new AppError(
        410,
        "Ce test a expiré. Récupérez à nouveau les articles.",
        "WORKFLOW_EXPIRED",
      );
    const article = preview.articles[index];
    if (!article) throw new AppError(404, "Article introuvable dans ce test.", "ARTICLE_NOT_FOUND");
    const { send, close } = startEventStream<WorkflowSummaryEvent>(res);
    const report = (
      stage: "content" | "ai",
      status: "running" | "completed" | "failed",
      message: string,
    ) =>
      reportProgress((progress) => send({ type: "progress", progress }), {
        stage,
        status,
        message,
      });
    let stage: "content" | "ai" = "content";
    try {
      report(stage, "running", `Téléchargement de la page complète : ${article.title}`);
      const { content, url } = await articleContent.fetchWithUrl(
        article.url,
        (message) => report("content", "running", message),
        source.type === "RSS" ? source.articleLinkSelector : null,
      );
      report(stage, "completed", `Texte de l'article extrait (${content.length} caractères).`);
      stage = "ai";
      report(stage, "running", `Envoi à l'IA : ${article.title}`);
      const result = await summary.summarize({ title: article.title, content, url }, (message) =>
        report("ai", "running", message),
      );
      report(stage, "completed", "Résumé IA terminé.");
      send({ type: "result", result: { content, url, summary: result } });
    } catch (error) {
      const message =
        error instanceof AppError ? error.message : "Le test de cet article a échoué.";
      report(stage, "failed", message);
      send({
        type: "error",
        message,
        code: error instanceof AppError ? error.code : "WORKFLOW_FAILED",
      });
    } finally {
      close();
    }
  });
  return router;
}
