import { Router } from "express";
import { z } from "zod";
import type { Db } from "./db";
import { requireAuth } from "./auth";
import { nextCollection, settingsSchema } from "./schedule";
import { getSettings, type CollectionRunner } from "./collection";
import type { CollectionEvent } from "@dailybrief/shared";
import { AppError } from "./errors";
import { startEventStream } from "./event-stream";
export function settingsRouter(db: Db, runner: CollectionRunner) {
  const router = Router();
  router.use(requireAuth);
  router.get("/settings/dailybrief", async (req, res) =>
    res.json(await getSettings(db, req.session.userId!)),
  );
  router.patch("/settings/dailybrief", async (req, res) => {
    const input = settingsSchema.parse(req.body);
    const userId = req.session.userId!;
    const settings = await getSettings(db, userId);
    const merged = { ...settings, ...input };
    res.json(
      await db.dailyBriefSettings.update({
        where: { userId },
        data: {
          ...input,
          nextCollectionAt: merged.collectionEnabled
            ? nextCollection(merged.collectionTime, merged.timezone)
            : null,
        },
      }),
    );
  });
  router.get("/dashboard", async (req, res) => {
    const userId = req.session.userId!;
    const settings = await getSettings(db, userId);
    const sources = await db.source.findMany({
      where: { userId },
      select: { type: true, enabled: true },
    });
    res.json({
      sources: {
        total: sources.length,
        rss: sources.filter((source) => source.type === "RSS").length,
        scraping: sources.filter((source) => source.type === "SCRAPING").length,
        enabled: sources.filter((source) => source.enabled).length,
      },
      collection: {
        enabled: settings.collectionEnabled,
        time: settings.collectionTime,
        timezone: settings.timezone,
        lastRunAt: settings.lastCollectionAt,
        nextRunAt: settings.nextCollectionAt,
      },
    });
  });
  router.post("/collection/run", async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    if (!req.get("accept")?.includes("application/x-ndjson")) {
      res.json(await runner.run(req.session.userId!));
      return;
    }
    const { send, close } = startEventStream<CollectionEvent>(res);
    try {
      const result = await runner.run(req.session.userId!, "manual", (progress) =>
        send({ type: "progress", progress }),
      );
      send({ type: "result", result });
    } catch (error) {
      send({
        type: "error",
        message: error instanceof AppError ? error.message : "Une erreur interne est survenue.",
        code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
      });
    } finally {
      close();
    }
  });
  return router;
}
