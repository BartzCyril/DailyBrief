import { writeFile, unlink } from "node:fs/promises";
import { logger } from "./logger";

export async function startWorkerHeartbeat(path: string): Promise<() => Promise<void>> {
  const write = () => writeFile(path, String(Date.now()), { mode: 0o600 });
  await write();
  const timer = setInterval(() => {
    void write().catch((error) =>
      logger.error(
        "worker.health_failed",
        "Impossible de mettre à jour le contrôle de santé du worker.",
        { error },
      ),
    );
  }, 10000);
  return async () => {
    clearInterval(timer);
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
}
