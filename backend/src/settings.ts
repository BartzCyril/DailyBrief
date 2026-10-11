import { Router } from "express";
import { z } from "zod";
import type { Db } from "./db";
import { requireAuth } from "./auth";
import { nextCollection, settingsSchema } from "./schedule";
import { getSettings, type CollectionRunner } from "./collection";
import type { CollectionEvent } from "@dailybrief/shared";
import { articleJobStatuses } from "@dailybrief/shared";
import { AppError } from "./errors";
import { startEventStream } from "./event-stream";
import type { JobsManager } from "./queue/jobs-manager";
import { latestBrief, briefSnapshot } from "./daily-brief";
export function settingsRouter(db: Db, runner: CollectionRunner, collections?: JobsManager) {
  const router = Router();
  router.use(requireAuth);
  router.get("/settings/dailybrief", async (req, res) =>
    res.json(await getSettings(db, req.session.userId!)),
  );
  router.get("/dailybrief/latest", async (req, res) =>
    res.json(await latestBrief(db, req.session.userId!)),
  );
  router.get("/dailybrief/:id", async (req, res) => {
    const brief = await db.dailyBrief.findFirst({
      where: {
        id: req.params.id!,
        userId: req.session.userId!,
        status: { in: ["READY", "EMPTY", "FAILED"] },
      },
    });
    if (!brief) throw new AppError(404, "Daily Brief introuvable.", "NOT_FOUND");
    res.json(briefSnapshot(brief));
  });
  router.get("/dailybrief/:id/articles", async (req, res) => {
    const input = z
      .object({ page: z.coerce.number().int().min(1).max(100000).default(1) })
      .strict()
      .parse(req.query);
    const userId = req.session.userId!;
    const brief = await db.dailyBrief.findFirst({
      where: { id: req.params.id!, userId, status: "READY" },
    });
    if (!brief) throw new AppError(404, "Daily Brief introuvable.", "NOT_FOUND");
    const where = { id: { in: brief.articleIds }, userId, summary: { not: null } };
    const response = await db.$transaction(
      async (tx) => {
        const total = await tx.article.count({ where });
        const pageSize = 5;
        const page = Math.min(input.page, Math.max(1, Math.ceil(total / pageSize)));
        const articles = await tx.article.findMany({
          where,
          orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            title: true,
            summaryTitle: true,
            url: true,
            contentUrl: true,
            summary: true,
            keyPoints: true,
            publishedAt: true,
          },
        });
        return {
          articles: articles.map(({ summaryTitle, contentUrl, ...article }) => ({
            ...article,
            title: summaryTitle ?? article.title,
            url: contentUrl ?? article.url,
          })),
          total,
          page,
          pageSize,
        };
      },
      { isolationLevel: "RepeatableRead" },
    );
    res.json(response);
  });
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
          ...(merged.collectionEnabled !== settings.collectionEnabled ||
          merged.collectionTime !== settings.collectionTime ||
          merged.timezone !== settings.timezone
            ? {
                nextCollectionAt: merged.collectionEnabled
                  ? nextCollection(merged.collectionTime, merged.timezone)
                  : null,
              }
            : {}),
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
        interestPrompt: settings.interestPrompt,
      },
      latestBrief: await latestBrief(db, userId),
    });
  });
  router.post("/collection/run", async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    if (collections) {
      res.status(202).json(await collections.enqueue(req.session.userId!));
      return;
    }
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
  router.get("/collection/current", async (req, res) =>
    res.json(collections ? await collections.current(req.session.userId!) : null),
  );
  router.get("/collection/runs", async (req, res) =>
    res.json(collections ? await collections.list(req.session.userId!) : []),
  );
  router.get("/collection/runs/:runId", async (req, res) => {
    if (!collections)
      throw new AppError(503, "La file de collecte n'est pas disponible.", "QUEUE_UNAVAILABLE");
    res.json(await collections.snapshot(req.session.userId!, req.params.runId!));
  });
  router.get("/collection/runs/:runId/jobs", async (req, res) => {
    if (!collections)
      throw new AppError(503, "La file de collecte n'est pas disponible.", "QUEUE_UNAVAILABLE");
    const input = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        status: z.enum(articleJobStatuses).default("all"),
      })
      .strict()
      .parse(req.query);
    res.json(
      await collections.jobs(req.session.userId!, req.params.runId!, input.page, input.status),
    );
  });
  return router;
}
