import { expect, spyOn, test } from "bun:test";
import type { Db } from "../src/db";
import { startScheduler } from "../src/scheduler";

test("recovers at startup then checks at hour boundaries without minute polling", async () => {
  let now = new Date("2026-10-12T12:37:00Z").getTime();
  const timers: { callback: () => void; delay: number; unref: () => void }[] = [];
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    const timer = { callback, delay, unref: () => {} };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setTimeout);
  const cleared = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  let queries = 0;
  let recoveries = 0;
  const db = {
    dailyBriefSettings: {
      findMany: async () => {
        queries++;
        return [];
      },
    },
  } as unknown as Db;
  const stop = startScheduler(db, {
    run: async () => {},
    recover: async () => {
      recoveries++;
    },
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  try {
    await flush();
    expect(queries).toBe(1);
    expect(recoveries).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delay).toBe(23 * 60 * 1000);
    now = new Date("2026-10-12T13:00:00Z").getTime();
    timers[0]!.callback();
    await flush();
    expect(queries).toBe(2);
    expect(timers[1]!.delay).toBe(60 * 60 * 1000);
    // An event loop delay must not move later checks away from the hour.
    now = new Date("2026-10-12T14:00:45Z").getTime();
    timers[1]!.callback();
    await flush();
    expect(queries).toBe(3);
    expect(timers[2]!.delay).toBe(60 * 60 * 1000 - 45000);
    stop();
    expect(cleared).toHaveBeenCalledWith(timers[2]);
  } finally {
    stop();
    timeout.mockRestore();
    cleared.mockRestore();
    clock.mockRestore();
  }
});
