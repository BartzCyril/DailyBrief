import { createClient } from "redis";
export function createRedis(url: string) { return createClient({ url }); }
export type Redis = ReturnType<typeof createRedis>;
