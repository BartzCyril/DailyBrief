import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import express from "express";
import request from "supertest";
import { readLoggingConfig } from "../src/config";
import {
  Logger,
  sanitizeLog,
  SmtpErrorAlertSender,
  requestLogging,
  withLogContext,
  type LogRecord,
} from "../src/logger";
import { AppError, errorHandler } from "../src/errors";

const directories: string[] = [];
async function errorPath() {
  const directory = await mkdtemp(join(tmpdir(), "dailybrief-logger-"));
  directories.push(directory);
  return join(directory, ".error");
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("structured logger", () => {
  test("filters debug by default, formats JSON and keeps concurrent contexts isolated", async () => {
    const lines: string[] = [];
    const log = new Logger({
      service: "consumers",
      format: "json",
      writeConsole: (line) => lines.push(line),
    });
    log.debug("hidden", "Détail masqué.");
    await Promise.all(
      ["first", "second"].map((runId) =>
        withLogContext({ runId }, async () => {
          await Promise.resolve();
          log.info("job.completed", "Job terminé.", { count: 2 });
        }),
      ),
    );
    const records = lines.map((line) => JSON.parse(line) as LogRecord);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.context.runId).sort()).toEqual(["first", "second"]);
    expect(records[0]).toMatchObject({
      level: "info",
      service: "consumers",
      event: "job.completed",
      context: { count: 2 },
    });
    const debug = new Logger({
      service: "backend",
      level: "debug",
      writeConsole: (line) => lines.push(line),
    });
    debug.debug("http.completed", "Requête terminée.");
    expect(lines[2]).toContain("DEBUG [backend] http.completed");
  });

  test("redacts credentials, provider data, URL tokens and untrusted exception messages", () => {
    const error = Object.assign(new Error("private-password <html>provider secret</html>"), {
      code: "ECONNREFUSED",
      response: "private-provider-data",
    });
    const clean = sanitizeLog(
      {
        password: "private-password",
        email: "private-user@example.com",
        cookie: "private-cookie",
        nested: {
          encryptedPassword: "private-cipher",
          prompt: "private-prompt",
          articleContent: "private-article",
        },
        url: "https://private-user:private-password@example.com/login?token=private-token#private-fragment",
        error,
        otherError: new Error("private-other-error"),
        aggregate: new AggregateError(
          [Object.assign(new Error("private-connection-details"), { code: "ECONNREFUSED" })],
          "private-aggregate-message",
        ),
        cause: { message: "private-object-error", response: "private-object-response" },
        text: "configured-secret\nforged console entry",
      },
      ["configured-secret"],
    );
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain("private-");
    expect(serialized).not.toContain("configured-secret");
    expect(serialized).not.toContain("provider secret");
    expect(clean).toMatchObject({
      error: { name: "Error", code: "ECONNREFUSED" },
      url: "https://example.com/login?[redacted]",
      cause: { name: "UnknownError" },
    });
  });

  test("persists every error including fatals with private permissions, and alerts only once per cooldown", async () => {
    const path = await errorPath();
    const alerts: LogRecord[] = [];
    let now = 1000;
    const log = new Logger({
      service: "backend",
      errorFile: path,
      writeConsole: () => {},
      now: () => now,
      cooldownMs: 1000,
      alertSender: {
        async send(record) {
          alerts.push(record);
        },
      },
    });
    log.info("boot", "Prêt.");
    log.error("redis.failed", "Redis indisponible.", {
      error: Object.assign(new Error("private-redis-secret"), { code: "ECONNREFUSED" }),
    });
    log.error("redis.failed", "Redis indisponible.");
    log.error("redis.failed", "Redis indisponible.");
    log.fatal("service.startup_failed", "Échec fatal.");
    expect(await log.flush()).toBe(true);
    // The code distinguishes failures with different causes; identical occurrences are deduplicated.
    expect(alerts).toHaveLength(3);
    now += 1000;
    log.error("redis.failed", "Redis indisponible.");
    await log.flush();
    expect(alerts).toHaveLength(4);
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LogRecord);
    expect(records).toHaveLength(5);
    expect(records[3]).toMatchObject({ level: "error", fatal: true });
    expect(JSON.stringify(records)).not.toContain("private-redis-secret");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("never blocks fatal alerts behind rate-limited ordinary errors", async () => {
    const alerts: LogRecord[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const log = new Logger({
      service: "consumers",
      writeConsole: () => {},
      alertSender: {
        async send(record) {
          alerts.push(record);
          if (!record.fatal) await blocked;
        },
      },
    });
    for (let i = 0; i < 20; i++) log.error(`job.failed_${i}`, "Échec d'un job.");
    log.fatal("service.uncaught_exception", "Arrêt fatal.");
    await Promise.resolve();
    await Promise.resolve();
    expect(alerts.some((record) => record.fatal)).toBe(true);
    release();
    await log.flush();
    expect(alerts).toHaveLength(11);
  });

  test("SMTP errors are written locally without recursively sending alerts", async () => {
    const path = await errorPath();
    const lines: string[] = [];
    let calls = 0;
    const log = new Logger({
      service: "backend",
      errorFile: path,
      writeConsole: (line) => lines.push(line),
      alertSender: {
        send() {
          calls++;
          throw new Error("private-smtp-password");
        },
      },
    });
    log.error("collection.failed", "Collecte en échec.");
    expect(await log.flush()).toBe(true);
    expect(calls).toBe(1);
    expect(lines.join("\n")).toContain("logger.email_failed");
    const file = await readFile(path, "utf8");
    expect(file).toContain("logger.email_failed");
    expect(file).not.toContain("private-smtp-password");
  });

  test("file failures still send an alert and flush is bounded if SMTP never answers", async () => {
    const path = await errorPath();
    const directory = join(path, "impossible", ".error");
    await Bun.write(path, "occupied");
    const lines: string[] = [];
    let sent = 0;
    const log = new Logger({
      service: "backend",
      errorFile: directory,
      writeConsole: (line) => lines.push(line),
      alertSender: {
        async send() {
          sent++;
        },
      },
    });
    log.fatal("service.startup_failed", "Échec fatal.");
    expect(await log.flush()).toBe(true);
    expect(sent).toBe(1);
    expect(lines.join("\n")).toContain("logger.file_failed");
    const hung = new Logger({
      service: "backend",
      writeConsole: () => {},
      alertSender: { send: () => new Promise(() => {}) },
    });
    hung.error("smtp.failed", "Erreur.");
    expect(await hung.flush(10)).toBe(false);
  });
});

test("SMTP alert uses the configured recipient, sanitized record and disables file/URL access", async () => {
  const config = readLoggingConfig({
    SMTP_USER: "admin@example.com",
    SMTP_PASSWORD: "private-password",
  });
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const spy = spyOn(transport, "sendMail");
  const sender = new SmtpErrorAlertSender(config, config.SMTP_USER!, transport);
  const log = new Logger({ service: "backend", writeConsole: () => {}, alertSender: sender });
  try {
    log.fatal("service.startup_failed", "Service indisponible.", {
      error: new Error("private-password"),
      password: "private-journal-password",
    });
    await log.flush();
    expect(spy).toHaveBeenCalledTimes(1);
    const message = spy.mock.calls[0]![0];
    expect(message).toMatchObject({
      to: "admin@example.com",
      from: config.SMTP_FROM,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(String(message.subject)).toContain("Erreur fatale");
    expect(String(message.text)).toContain("service.startup_failed");
    expect(JSON.stringify(message)).not.toContain("private-");
  } finally {
    spy.mockRestore();
  }
});

test("unexpected HTTP errors have a request ID without leaking request data; expected failures do not alert", async () => {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation((line) => {
    lines.push(String(line));
    return true;
  });
  const app = express();
  app.use(requestLogging, express.json());
  app.post("/fail/:id", () => {
    throw new Error("private-provider-message");
  });
  app.get("/expected", () => {
    throw new AppError(400, "Données invalides.");
  });
  app.get("/unavailable", () => {
    throw new AppError(503, "private-upstream-message", "AI_UNAVAILABLE");
  });
  app.use(errorHandler);
  try {
    const result = await request(app)
      .post("/fail/private-id?token=private-token")
      .set("Authorization", "private-authorization")
      .send({ password: "private-password" });
    expect(result.status).toBe(500);
    expect(result.headers["x-request-id"]).toMatch(/^[a-f0-9-]{36}$/);
    expect(lines.join("\n")).toContain(String(result.headers["x-request-id"]));
    expect(lines.join("\n")).not.toContain("private-");
    expect((await request(app).get("/expected")).status).toBe(400);
    expect(lines).toHaveLength(1);
    expect((await request(app).get("/unavailable")).status).toBe(503);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("AI_UNAVAILABLE");
    expect(lines[1]).not.toContain("private-upstream-message");
  } finally {
    spy.mockRestore();
  }
});

test("logging settings validate levels and can be read despite missing database configuration", () => {
  expect(readLoggingConfig({})).toMatchObject({
    LOG_LEVEL: "info",
    LOG_ERROR_FILE: ".error",
    ERROR_EMAIL_ENABLED: true,
  });
  expect(() => readLoggingConfig({ LOG_LEVEL: "verbose" })).toThrow();
  expect(() => readLoggingConfig({ ERROR_EMAIL_TO: "invalid" })).toThrow();
});
