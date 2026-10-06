import { spawnSync } from "node:child_process";
import { Pool } from "pg";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a dedicated _test database");
const adminUrl = new URL(url);
const database = decodeURIComponent(adminUrl.pathname.slice(1));
if (!/^[A-Za-z_][A-Za-z0-9_]*_test$/.test(database)) throw new Error("Invalid test database name");
adminUrl.pathname = "/postgres";
const admin = new Pool({ connectionString: adminUrl.href });
try {
  if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount) {
    await admin.query(`CREATE DATABASE "${database}"`);
  }
} finally {
  await admin.end();
}
const result = spawnSync("bun", ["scripts/migrate.ts"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(result.status ?? 1);
