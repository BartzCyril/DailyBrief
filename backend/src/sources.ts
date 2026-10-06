import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "./auth";
import type { Db } from "./db";
import { RssService } from "./rss";

export const urlSchema = z.url({ protocol: /^https?$/ });
export function sourcesRouter(db: Db, rss: RssService) {
  const router = Router(); router.use(requireAuth);
  router.post("/rss/test", async (req, res) => {
    const { url } = z.object({ url: urlSchema }).strict().parse(req.body);
    const result = await rss.collect(url); res.json({ ...result, articles: result.articles.slice(0, 20) });
  });
  router.get("/", async (req, res) => res.json(await db.source.findMany({ where: { userId: req.session.userId! }, orderBy: { createdAt: "desc" } })));
  router.post("/", async (req, res) => {
    const input = z.object({ url: urlSchema, type: z.literal("RSS") }).strict().parse(req.body);
    await rss.collect(input.url);
    res.status(201).json(await db.source.create({ data: { userId: req.session.userId!, url: new URL(input.url).href, type: "RSS" } }));
  });
  return router;
}
