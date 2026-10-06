import { readdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

// Apply checked-in Prisma SQL migrations without a native schema-engine download.
// The metadata format is compatible with Prisma's _prisma_migrations table.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(1839467351)");
  await client.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ, migration_name VARCHAR(255) NOT NULL,
    logs TEXT, rolled_back_at TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0)`);
  const directories = await readdir(new URL("../prisma/migrations/", import.meta.url)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const name of directories.sort().filter((name) => /^\d/.test(name))) {
    const sql = await readFile(
      new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
      "utf8",
    );
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query<{ checksum: string; finished_at: Date | null }>(
      'SELECT checksum, finished_at FROM "_prisma_migrations" WHERE migration_name = $1 AND rolled_back_at IS NULL',
      [name],
    );
    if (existing.rowCount) {
      if (existing.rows[0]?.checksum !== checksum || !existing.rows[0]?.finished_at)
        throw new Error(`Migration ${name} is incomplete or has changed`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count) VALUES ($1,$2,$3,now(),1)',
        [randomUUID(), checksum, name],
      );
      await client.query("COMMIT");
      console.info(`Applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  try {
    await client.query("SELECT pg_advisory_unlock(1839467351)");
  } finally {
    client.release();
    await pool.end();
  }
}
