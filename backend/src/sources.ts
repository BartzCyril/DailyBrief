import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "./auth";
import type { Db } from "./db";
import { RssService } from "./rss";
import { ScrapingService } from "./scraping";
import { scrapingInputSchema } from "../../shared/src/scraping";
import { AppError } from "./errors";
import { articleLinkSelectorSchema } from "../../shared/src/rss";
import { validateArticleLinkSelector } from "./article-content";

export const urlSchema = z.url({ protocol: /^https?$/ });
export function sourcesRouter(db: Db, rss: RssService, scraping: ScrapingService) {
  const router = Router();
  router.use(requireAuth);
  router.post("/rss/test", async (req, res) => {
    const { url, articleLinkSelector } = z
      .object({ url: urlSchema, articleLinkSelector: articleLinkSelectorSchema })
      .strict()
      .parse(req.body);
    validateArticleLinkSelector(articleLinkSelector);
    const result = await rss.collect(url);
    res.json({ ...result, articles: result.articles.slice(0, 20) });
  });
  router.get("/", async (req, res) =>
    res.json(
      await db.source.findMany({
        where: { userId: req.session.userId! },
        orderBy: { createdAt: "desc" },
      }),
    ),
  );
  router.post("/scraping/test", async (req, res) => {
    const input = z
      .object({ url: urlSchema, config: scrapingInputSchema })
      .strict()
      .parse(req.body);
    const result = await scraping.collect(input.url, input.config);
    res.json({ ...result, articles: result.articles.slice(0, 50) });
  });
  router.delete("/:id", async (req, res) => {
    const result = await db.source.deleteMany({
      where: { id: String(req.params.id), userId: req.session.userId! },
    });
    if (!result.count) throw new AppError(404, "Source introuvable.", "SOURCE_NOT_FOUND");
    res.status(204).end();
  });
  router.patch("/:id", async (req, res) => {
    const input = z
      .object({
        enabled: z.boolean().optional(),
        url: urlSchema.optional(),
        scrapingConfig: scrapingInputSchema.optional(),
        articleLinkSelector: articleLinkSelectorSchema,
        urlTemplate: z.string().trim().min(1).max(2000).optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.url !== undefined ||
          value.enabled !== undefined ||
          value.scrapingConfig !== undefined ||
          value.articleLinkSelector !== undefined,
      )
      .refine((value) => value.urlTemplate === undefined || value.url !== undefined)
      .refine((value) => value.urlTemplate === undefined || value.scrapingConfig === undefined)
      .parse(req.body);
    const userId = req.session.userId!;
    const id = String(req.params.id);
    const source = await db.source.findFirst({ where: { id, userId } });
    if (!source) throw new AppError(404, "Source introuvable.", "SOURCE_NOT_FOUND");
    const data: {
      enabled?: boolean;
      url?: string;
      scrapingConfig?: z.infer<typeof scrapingInputSchema>;
      articleLinkSelector?: string | null;
    } = {};
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.articleLinkSelector !== undefined) {
      if (source.type !== "RSS")
        throw new AppError(
          400,
          "Le sélecteur de lien intermédiaire est réservé aux flux RSS.",
          "VALIDATION_ERROR",
        );
      validateArticleLinkSelector(input.articleLinkSelector);
      data.articleLinkSelector = input.articleLinkSelector;
    }
    if (input.url !== undefined || input.scrapingConfig !== undefined) {
      const url = input.url === undefined ? source.url : new URL(input.url).href;
      if (input.url !== undefined) data.url = url;
      const duplicate = await db.source.findFirst({
        where: { userId, url, id: { not: id } },
      });
      if (duplicate) throw new AppError(409, "Une source utilise déjà cette URL.", "DUPLICATE");
      if (source.type === "RSS") {
        if (input.urlTemplate !== undefined || input.scrapingConfig !== undefined)
          throw new AppError(
            400,
            "Un flux RSS n'utilise pas de configuration de scraping.",
            "VALIDATION_ERROR",
          );
        if (url !== source.url) await rss.collect(url);
      } else {
        const config = input.scrapingConfig ?? scrapingInputSchema.parse(source.scrapingConfig);
        const templatePagination =
          config.mode === "PAGINATE" && config.pagination?.strategy === "URL_TEMPLATE";
        if (input.urlTemplate !== undefined && !templatePagination)
          throw new AppError(
            400,
            "Cette source n'utilise pas de modèle de pagination.",
            "VALIDATION_ERROR",
          );
        if (
          templatePagination &&
          url !== source.url &&
          input.urlTemplate === undefined &&
          input.scrapingConfig === undefined
        )
          throw new AppError(
            400,
            "Précisez également le modèle d'URL de pagination pour cette source.",
            "VALIDATION_ERROR",
          );
        const updated =
          input.urlTemplate === undefined
            ? config
            : scrapingInputSchema.parse({
                ...config,
                pagination: { ...config.pagination, urlTemplate: input.urlTemplate },
              });
        if (
          url !== source.url ||
          input.scrapingConfig !== undefined ||
          (input.urlTemplate !== undefined && input.urlTemplate !== config.pagination?.urlTemplate)
        )
          await scraping.validateFirstPage(url, updated);
        if (input.urlTemplate !== undefined || input.scrapingConfig !== undefined)
          data.scrapingConfig = updated;
      }
    }
    const result = await db.source.updateMany({
      where: { id, userId },
      data,
    });
    if (!result.count) throw new AppError(404, "Source introuvable.");
    res.status(204).end();
  });
  router.post("/", async (req, res) => {
    const input = z
      .discriminatedUnion("type", [
        z
          .object({
            url: urlSchema,
            type: z.literal("RSS"),
            articleLinkSelector: articleLinkSelectorSchema,
          })
          .strict(),
        z
          .object({
            url: urlSchema,
            type: z.literal("SCRAPING"),
            scrapingConfig: scrapingInputSchema,
          })
          .strict(),
      ])
      .parse(req.body);
    if (input.type === "RSS") {
      validateArticleLinkSelector(input.articleLinkSelector);
      await rss.collect(input.url);
    } else await scraping.validateFirstPage(input.url, input.scrapingConfig);
    res.status(201).json(
      await db.source.create({
        data: {
          userId: req.session.userId!,
          url: new URL(input.url).href,
          type: input.type,
          ...(input.type === "SCRAPING"
            ? { scrapingConfig: input.scrapingConfig }
            : { articleLinkSelector: input.articleLinkSelector ?? null }),
        },
      }),
    );
  });
  return router;
}
