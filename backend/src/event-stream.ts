import type { Response } from "express";

export function startEventStream<T>(res: Response) {
  res.status(200).set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const send = (event: T) => {
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write("\n");
  }, 15000);
  heartbeat.unref();
  res.on("close", () => clearInterval(heartbeat));
  return {
    send,
    close: () => {
      clearInterval(heartbeat);
      if (!res.destroyed && !res.writableEnded) res.end();
    },
  };
}
