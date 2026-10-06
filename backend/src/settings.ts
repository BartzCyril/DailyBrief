import { Router } from "express";
import { z } from "zod";
import type { Db } from "./db";
import { requireAuth } from "./auth";
import { nextCollection, settingsSchema } from "./schedule";
import { getSettings, type CollectionRunner } from "./collection";
import type { CollectionEvent } from "@dailybrief/shared";
import { AppError } from "./errors";
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
    res.status(200).set({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let connected = true;
    res.on("close", () => {
      connected = false;
    });
    const send = (event: CollectionEvent) => {
      if (connected && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };
    const heartbeat = setInterval(() => {
      if (connected && !res.destroyed) res.write("\n");
    }, 15000);
    heartbeat.unref();
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
      clearInterval(heartbeat);
      if (connected) res.end();
    }
  });
  return router;
}
