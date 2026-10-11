import { bootstrapLogger, logger } from "./logger";

type Cleanup = () => void | Promise<unknown>;

export async function runService(
  service: "backend" | "consumers",
  start: (
    defer: (cleanup: Cleanup) => void,
    fatal: (event: string, error: unknown) => Promise<void>,
  ) => Promise<void>,
) {
  const cleanups: Cleanup[] = [];
  let stopping = false;
  let failing = false;
  const fatal = async (event: string, error: unknown) => {
    if (failing) return;
    failing = true;
    logger.fatal(event, "Le service doit s'arrêter à la suite d'une erreur fatale.", { error });
    if (!(await logger.flush()))
      logger.info(
        "service.alert_timeout",
        "Délai d'envoi des alertes dépassé ; l'erreur reste dans .error.",
      );
    process.exit(1);
  };
  process.on("uncaughtException", (error) => void fatal("service.uncaught_exception", error));
  process.on("unhandledRejection", (error) => void fatal("service.unhandled_rejection", error));
  const shutdown = async (signal: string) => {
    if (stopping || failing) return;
    stopping = true;
    logger.info("service.stopping", "Arrêt du service demandé.", { signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drained = await Promise.race([
        (async () => {
          for (const cleanup of cleanups) await cleanup();
          return true;
        })(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 30000);
        }),
      ]);
      if (!drained)
        logger.info(
          "service.shutdown_timeout",
          "Arrêt après le délai de fermeture ; les jobs interrompus seront repris par Redis.",
        );
      logger.info("service.stopped", "Service arrêté.");
      await logger.flush();
      process.exit(0);
    } catch (error) {
      await fatal("service.shutdown_failed", error);
    } finally {
      clearTimeout(timer);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  try {
    bootstrapLogger(service);
    logger.info("service.starting", "Démarrage du service.");
    await start((cleanup) => cleanups.unshift(cleanup), fatal);
  } catch (error) {
    await fatal("service.startup_failed", error);
  }
}
