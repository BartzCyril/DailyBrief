import { expect, test } from "bun:test";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";

test("hourly migration rounds legacy times in their own timezone without changing activation", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw new Error("Use a dedicated _test database");
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Temporary table shadows the application table on this connection only.
    await client.query(`CREATE TEMP TABLE "DailyBriefSettings" (
      "userId" text, "collectionTime" text DEFAULT '07:30', "timezone" text,
      "collectionEnabled" boolean, "nextCollectionAt" timestamp
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO "DailyBriefSettings" VALUES
      ('paris', '07:30', 'Europe/Paris', true, '2026-10-13 05:30:00'),
      ('ny', '08:45', 'America/New_York', true, '2026-10-13 12:45:00'),
      ('india', '07:30', 'Asia/Kolkata', true, '2026-10-13 02:00:00'),
      ('disabled', '14:59', 'UTC', false, NULL)`);
    const migration = await readFile(
      new URL("../prisma/migrations/202610120001_hourly_collection/migration.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    const result = await client.query(`SELECT "userId", "collectionTime", "collectionEnabled",
      to_char("nextCollectionAt", 'YYYY-MM-DD HH24:MI') AS next
      FROM "DailyBriefSettings" ORDER BY "userId"`);
    expect(result.rows).toEqual([
      { userId: "disabled", collectionTime: "14:00", collectionEnabled: false, next: null },
      {
        userId: "india",
        collectionTime: "07:00",
        collectionEnabled: true,
        next: "2026-10-13 01:30",
      },
      { userId: "ny", collectionTime: "08:00", collectionEnabled: true, next: "2026-10-13 12:00" },
      {
        userId: "paris",
        collectionTime: "07:00",
        collectionEnabled: true,
        next: "2026-10-13 05:00",
      },
    ]);
    await expect(
      client.query(`INSERT INTO "DailyBriefSettings" ("collectionTime") VALUES ('08:45')`),
    ).rejects.toThrow();
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
