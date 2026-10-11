import type { Db } from "./db";
import type { RunTrigger } from "./collection";
import { logger } from "./logger";
import { AppError } from "./errors";
type ScheduledRunner = {
  run(userId: string, trigger?: RunTrigger): Promise<unknown>;
  recover?: () => Promise<void>;
};
export async function runDueCollections(db: Db, runner: ScheduledRunner, now = new Date()) {
  const due = await db.dailyBriefSettings.findMany({
    where: { collectionEnabled: true, nextCollectionAt: { lte: now } },
    take: 100,
    orderBy: { nextCollectionAt: "asc" },
  });
  if (due.length)
    logger.info("scheduler.due", "Collectes quotidiennes à planifier.", { count: due.length });
  for (const settings of due) {
    try {
      await runner.run(settings.userId, "scheduled");
    } catch (error) {
      if (error instanceof AppError && error.code === "COLLECTION_RUNNING")
        logger.debug(
          "scheduler.collection_busy",
          "Une collecte est déjà en cours pour ce compte.",
          { userId: settings.userId },
        );
      else
        logger.error(
          "scheduler.collection_failed",
          "Impossible de planifier une collecte quotidienne.",
          { userId: settings.userId, error },
        );
    }
  }
}
export function startScheduler(db: Db, runner: ScheduledRunner) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runner.recover?.();
      await runDueCollections(db, runner);
    } catch (error) {
      logger.error(
        "scheduler.tick_failed",
        "La vérification des collectes quotidiennes a échoué.",
        { error },
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 60000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
