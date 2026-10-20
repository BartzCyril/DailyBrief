import IORedis from "ioredis";
import { z } from "zod";
import { createDb } from "../src/db";
import { historySnapshot, resetHistory } from "../src/reset-history";

const usage = `Vider l'historique DailyBrief (tous les utilisateurs de DATABASE_URL).
Arrêtez l'API et les workers ; laissez PostgreSQL et Redis démarrés.

  npm run db:reset-history           Aperçu, sans suppression
  npm run db:reset-history -- --yes  Suppression définitive

Conserve les utilisateurs, sources, réglages et accès aux journaux.
Supprime articles/résumés, newsletters, Daily Briefs, exécutions et jobs Redis.
Les horaires et nextCollectionAt sont conservés ; lastCollectionAt est effacé.
Les sessions Redis et les files sans lien avec cette base sont conservées.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  if (args.some((arg) => arg !== "--yes" && arg !== "--dry-run"))
    throw new Error(`Option inconnue.\n${usage}`);
  if (args.includes("--yes") && args.includes("--dry-run"))
    throw new Error("Choisissez --yes ou --dry-run, pas les deux.");
  const config = z
    .object({
      DATABASE_URL: z.url(),
      REDIS_URL: z.url().default("redis://127.0.0.1:6379"),
      QUEUE_PREFIX: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .default("dailybrief"),
    })
    .parse(process.env);
  const db = createDb(config.DATABASE_URL);
  const redis = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 5000,
    lazyConnect: true,
  });
  redis.on("error", () => {});
  try {
    console.log(`Base ciblée : ${new URL(config.DATABASE_URL).pathname.slice(1)}`);
    const snapshot = args.includes("--yes")
      ? await resetHistory(db, redis, config.QUEUE_PREFIX)
      : await historySnapshot(db, redis, config.QUEUE_PREFIX);
    console.log(`Files Redis concernées : ${snapshot.prefixes.join(", ")}`);
    console.log("Conservés :", snapshot.kept);
    console.log(args.includes("--yes") ? "Supprimés :" : "À supprimer :", snapshot.removed);
    console.log(
      args.includes("--yes")
        ? "Historique vidé. Vous pouvez redémarrer l'application."
        : "Aucune donnée modifiée. Arrêtez l'API et les workers, puis ajoutez --yes pour supprimer.",
    );
  } finally {
    await db.$disconnect();
    redis.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Échec de la remise à zéro.");
  process.exitCode = 1;
});
