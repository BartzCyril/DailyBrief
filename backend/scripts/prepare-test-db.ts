import { spawnSync } from "node:child_process";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("Use a dedicated _test database");
const result = spawnSync("bun", ["scripts/migrate.ts"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
process.exit(result.status ?? 1);
