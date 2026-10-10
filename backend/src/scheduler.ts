import type { Db } from "./db";
import type { RunTrigger } from "./collection";
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
  for (const settings of due) {
    try {
      await runner.run(settings.userId, "scheduled");
    } catch {
      console.error("Scheduled collection failed", settings.userId);
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
