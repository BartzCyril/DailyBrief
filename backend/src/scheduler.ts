import type { Db } from "./db";
import type { CollectionRunner } from "./collection";
export async function runDueCollections(db: Db, runner: CollectionRunner, now = new Date()) {
  const due = await db.dailyBriefSettings.findMany({
    where: { collectionEnabled: true, nextCollectionAt: { lte: now } },
    take: 100,
    orderBy: { nextCollectionAt: "asc" },
  });
  for (const settings of due) {
    try {
      await runner.run(settings.userId, "scheduled");
    } catch {
      console.error("Scheduled collection failed", settings.userId);
    }
  }
}
export function startScheduler(db: Db, runner: CollectionRunner) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueCollections(db, runner);
    } catch {
      console.error("Scheduler tick failed");
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
