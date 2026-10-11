import { runService } from "../../src/service-runtime";

const mode = process.argv[2];
await runService("consumers", async (defer) => {
  if (mode === "startup") throw new Error("private-startup-secret");
  if (mode === "rejection") {
    void Promise.reject(new Error("private-rejection-secret"));
  } else if (mode === "exception") {
    setTimeout(() => {
      throw new Error("private-exception-secret");
    }, 0);
  } else {
    // Keep the event loop alive until the signal handler has received SIGTERM.
    const keepAlive = setInterval(() => {}, 1000);
    defer(() => clearInterval(keepAlive));
    defer(async () => {
      if (mode === "shutdown") throw new Error("private-shutdown-secret");
    });
    setTimeout(() => process.emit("SIGTERM"), 10);
  }
});
