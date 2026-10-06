import { randomUUID } from "node:crypto";
import type { Redis } from "./redis";
import { AppError } from "./errors";
export class UserCollectionLock {
  constructor(private redis: Redis, private ttlMs = 120000) {}
  async run<T>(userId: string, task: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
    const key = `dailybrief:collection:user:${userId}`; const token = randomUUID();
    if (!await this.redis.set(key, token, { NX: true, PX: this.ttlMs })) throw new AppError(409, "Une collecte est déjà en cours.", "COLLECTION_RUNNING");
    let lost = false;
    const timer = setInterval(() => {
      void this.redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end", { keys: [key], arguments: [token, String(this.ttlMs)] }).then(result => { if (!result) lost = true; }).catch(() => { lost = true; });
    }, Math.max(50, Math.floor(this.ttlMs / 3)));
    timer.unref();
    const assertOwned = async () => { if (lost || await this.redis.get(key) !== token) throw new AppError(409, "Le verrou de collecte a expiré. Réessayez.", "LOCK_LOST"); };
    try { return await task(assertOwned); }
    finally {
      clearInterval(timer);
      await this.redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", { keys: [key], arguments: [token] }).catch(() => {});
    }
  }
}
