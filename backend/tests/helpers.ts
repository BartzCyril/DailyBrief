import { createClient } from "redis";
import { readConfig } from "../src/config";
import { createDb } from "../src/db";
import { createApp } from "../src/app";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("TEST_DATABASE_URL must point to a dedicated _test database");
export const config = readConfig({ ...process.env, DATABASE_URL: url, NODE_ENV: "test" });
export const db = createDb(url);
export const redis = createClient({ url: config.REDIS_URL });
redis.on("error", () => {});
export const app = createApp(db, redis, config);
export async function connect() { if (!redis.isOpen) await redis.connect(); await db.$connect(); }
export async function disconnect() { await db.$disconnect(); if (redis.isOpen) await redis.quit(); }
