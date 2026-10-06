import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "./auth";
import type { Db } from "./db";
import { RssService } from "./rss";
import { ScrapingService } from "./scraping";
import { scrapingSchema } from "../../shared/src/scraping";
import { AppError } from "./errors";

export const urlSchema = z.url({ protocol: /^https?$/ });
export function sourcesRouter(db: Db, rss: RssService, scraping: ScrapingService) {
  const router = Router(); router.use(requireAuth);
  router.post("/rss/test", async (req, res) => {
    const { url } = z.object({ url: urlSchema }).strict().parse(req.body);
    const result = await rss.collect(url); res.json({ ...result, articles: result.articles.slice(0, 20) });
  });
  router.get("/", async (req, res) => res.json(await db.source.findMany({ where: { userId: req.session.userId! }, orderBy: { createdAt: "desc" } })));
  router.post("/scraping/test", async (req, res) => {
    const input = z.object({ url: urlSchema, config: scrapingSchema }).strict().parse(req.body);
    const result = await scraping.collect(input.url, input.config); res.json({ ...result, articles: result.articles.slice(0, 50) });
  });
  router.patch("/:id", async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const result = await db.source.updateMany({ where: { id: String(req.params.id), userId: req.session.userId! }, data: { enabled } });
    if (!result.count) throw new AppError(404, "Source introuvable.");
    res.status(204).end();
  });
  router.post("/", async (req, res) => {
    const input = z.discriminatedUnion("type", [z.object({ url: urlSchema, type: z.literal("RSS") }).strict(), z.object({ url: urlSchema, type: z.literal("SCRAPING"), scrapingConfig: scrapingSchema }).strict()]).parse(req.body);
    if (input.type === "RSS") await rss.collect(input.url); else await scraping.collect(input.url, input.scrapingConfig);
    res.status(201).json(await db.source.create({ data: { userId: req.session.userId!, url: new URL(input.url).href, type: input.type, ...(input.type === "SCRAPING" ? { scrapingConfig: input.scrapingConfig } : {}) } }));
  });
  return router;
}
