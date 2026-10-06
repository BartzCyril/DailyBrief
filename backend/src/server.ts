import { createApp } from "./app";
import { createClient } from "redis";
import { readConfig } from "./config";
import { createDb } from "./db";
const config = readConfig();
const db = createDb(config.DATABASE_URL);
const redis = createClient({ url: config.REDIS_URL });
redis.on("error", () => console.error("Redis connection error"));
await Promise.all([db.$connect(), redis.connect()]);
const server = createApp(db, redis, config).listen(config.PORT, () => console.info(`DailyBrief listening on port ${config.PORT}`));
async function shutdown() { server.close(); await Promise.all([db.$disconnect(), redis.quit()]); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
