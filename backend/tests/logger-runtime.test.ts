import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [mode, event] of [
  ["startup", "service.startup_failed"],
  ["exception", "service.uncaught_exception"],
  ["rejection", "service.unhandled_rejection"],
  ["shutdown", "service.shutdown_failed"],
] as const) {
  test(`${mode} failures are flushed to .error before exit code 1`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dailybrief-runtime-"));
    const errorFile = join(directory, ".error");
    try {
      const child = Bun.spawn([process.execPath, "tests/fixtures/logger-runtime.ts", mode], {
        env: {
          ...process.env,
          NODE_ENV: "test",
          LOG_LEVEL: "info",
          LOG_FORMAT: "json",
          LOG_ERROR_FILE: errorFile,
          ERROR_EMAIL_ENABLED: "false",
          ERROR_EMAIL_TO: "",
          SMTP_FROM: "test@example.com",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exit).toBe(1);
      expect(output).not.toContain("private-");
      const records = (await readFile(errorFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        service: "consumers",
        level: "error",
        fatal: true,
        event,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("ordinary SIGTERM shutdown exits successfully without a fatal record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dailybrief-shutdown-"));
  const errorFile = join(directory, ".error");
  try {
    const child = Bun.spawn([process.execPath, "tests/fixtures/logger-runtime.ts", "normal"], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOG_FORMAT: "json",
        LOG_ERROR_FILE: errorFile,
        ERROR_EMAIL_ENABLED: "false",
        ERROR_EMAIL_TO: "",
        SMTP_FROM: "test@example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exit).toBe(0);
    expect(output).toContain("service.stopped");
    expect(await Bun.file(errorFile).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
