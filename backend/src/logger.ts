import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { open, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestHandler } from "express";
import type { Transporter } from "nodemailer";
import { z } from "zod";
import { readLoggingConfig, type LoggingConfig } from "./config";
import { createSmtpTransport } from "./smtp";

export type LogLevel = "debug" | "info" | "error";
export type LogContext = Record<string, unknown>;
export type LogRecord = {
  timestamp: string;
  level: LogLevel;
  service: string;
  event: string;
  message: string;
  fatal?: true;
  context: LogContext;
};
const priorities = { debug: 10, info: 20, error: 30 };
const scopes = new AsyncLocalStorage<LogContext>();
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const sensitiveKey =
  /password|passwd|secret|token|authorization|cookie|session|credential|email(?:$|_)|username|prompt|content|html|body|response|database.?url|redis.?url|encryption|api.?key/i;

// Exception messages may contain a provider response, a form value or a connection URL.
// Keep diagnostic codes and call sites, never serialize the original message or arbitrary properties.
function exceptionDetails(error: unknown): LogContext {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const field = (key: string) => {
    const value = (error as unknown as LogContext)[key];
    const pattern = key === "code" ? /^[A-Z][A-Z0-9_]{0,79}$/ : /^[A-Za-z0-9_]{1,80}$/;
    return typeof value === "string" && pattern.test(value) ? value : undefined;
  };
  return {
    name: field("name") ?? "Error",
    ...(field("code") ? { code: field("code") } : {}),
    ...(error.cause instanceof Error ? { cause: error.cause } : {}),
    ...(error instanceof AggregateError
      ? { errors: error.errors.filter((item) => item instanceof Error).slice(0, 3) }
      : {}),
    stack: error.stack
      ?.split("\n")
      .slice(1)
      .filter((line) => /^\s*at [A-Za-z0-9_.$ /\\:@()<>-]+:\d+:\d+\)?$/.test(line))
      .slice(0, 8),
    ...(error.name === "ZodError" && "issues" in error && Array.isArray(error.issues)
      ? {
          invalidFields: error.issues.map((issue: { path?: unknown[] }) =>
            issue.path?.filter((part) => typeof part === "string").join("."),
          ),
        }
      : {}),
  };
}

export function sanitizeLog(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value instanceof Error) return sanitizeLog(exceptionDetails(value), secrets, depth + 1);
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[redacted]");
    text = text.replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
      } catch {
        return "[redacted URL]";
      }
    });
    return text.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 1500);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeLog(item, secrets, depth + 1));
  if (typeof value === "object" && value) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, item]) => [
          key,
          sensitiveKey.test(key)
            ? "[redacted]"
            : sanitizeLog(
                key === "error" || key === "cause" ? exceptionDetails(item) : item,
                secrets,
                depth + 1,
              ),
        ]),
    );
  }
  return undefined;
}

export interface ErrorAlertSender {
  send(record: LogRecord): Promise<void>;
}
export class SmtpErrorAlertSender implements ErrorAlertSender {
  private transport: Transporter;
  constructor(
    private config: LoggingConfig,
    private recipient: string,
    transport?: Transporter,
  ) {
    this.transport = transport ?? createSmtpTransport(config, true);
  }
  async send(record: LogRecord) {
    await this.transport.sendMail({
      from: this.config.SMTP_FROM,
      to: this.recipient,
      subject: `[DailyBrief] ${record.fatal ? "Erreur fatale" : "Erreur"} · ${record.service} · ${record.event}`,
      text: `${record.message}\n\n${JSON.stringify(record, null, 2)}\n\nLes répétitions de cette erreur sont conservées dans .error et regroupées pendant le délai configuré.`,
      messageId: `<${randomUUID()}@dailybrief.local>`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
}

type LoggerOptions = {
  service: string;
  level?: LogLevel;
  format?: "pretty" | "json";
  errorFile?: string;
  secrets?: string[];
  alertSender?: ErrorAlertSender;
  cooldownMs?: number;
  now?: () => number;
  writeConsole?: (line: string, level: LogLevel) => void;
};

export class Logger {
  private fileWrites = Promise.resolve();
  private alerts = Promise.resolve();
  private urgentAlerts = new Set<Promise<void>>();
  private lastAlerts = new Map<string, number>();
  private alertTimes: number[] = [];
  private now: () => number;
  constructor(private options: LoggerOptions) {
    this.now = options.now ?? Date.now;
  }
  debug(event: string, message: string, context: LogContext = {}) {
    this.log("debug", event, message, context);
  }
  info(event: string, message: string, context: LogContext = {}) {
    this.log("info", event, message, context);
  }
  error(event: string, message: string, context: LogContext = {}) {
    this.log("error", event, message, context);
  }
  fatal(event: string, message: string, context: LogContext = {}) {
    this.log("error", event, message, context, true);
  }
  private output(record: LogRecord) {
    const line =
      this.options.format === "json"
        ? JSON.stringify(record)
        : `${record.timestamp} ${record.fatal ? "FATAL" : record.level.toUpperCase()} [${record.service}] ${record.event} — ${record.message}${Object.keys(record.context).length ? ` ${JSON.stringify(record.context)}` : ""}`;
    try {
      if (this.options.writeConsole) this.options.writeConsole(line, record.level);
      else (record.level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
    } catch {
      // Logging must never break a request or the queue's recovery logic.
    }
  }
  private fallback(event: string, message: string, error: unknown, persist = false) {
    const record: LogRecord = {
      timestamp: new Date(this.now()).toISOString(),
      level: "error",
      service: this.options.service,
      event,
      message,
      context: sanitizeLog({ error }, this.options.secrets) as LogContext,
    };
    this.output(record);
    if (persist) this.persist(record);
  }
  private persist(record: LogRecord) {
    if (!this.options.errorFile) return;
    this.fileWrites = this.fileWrites
      .then(async () => {
        const path = this.options.errorFile!;
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const file = await open(path, "a", 0o600);
        try {
          await file.chmod(0o600);
          await file.appendFile(`${JSON.stringify(record)}\n`);
        } finally {
          await file.close();
        }
      })
      .catch((error) =>
        this.fallback("logger.file_failed", "Écriture du fichier .error impossible.", error),
      );
  }
  private log(level: LogLevel, event: string, message: string, context: LogContext, fatal = false) {
    if (priorities[level] < priorities[this.options.level ?? "info"]) return;
    const record = sanitizeLog(
      {
        timestamp: new Date(this.now()).toISOString(),
        level,
        service: this.options.service,
        event,
        message,
        ...(fatal ? { fatal: true } : {}),
        context: { ...scopes.getStore(), ...context },
      },
      this.options.secrets,
    ) as LogRecord;
    this.output(record);
    if (level !== "error") return;
    this.persist(record);
    if (!this.options.alertSender) return;
    const now = this.now();
    const cooldown = this.options.cooldownMs ?? 300000;
    const errorCode =
      (record.context.error as LogContext | undefined)?.code ??
      record.context.failureCode ??
      record.context.code;
    const fingerprint = `${fatal}:${event}:${errorCode ?? ""}`;
    const previous = this.lastAlerts.get(fingerprint);
    this.alertTimes = this.alertTimes.filter((time) => now - time < cooldown);
    if (
      (previous !== undefined && now - previous < cooldown) ||
      (!fatal && this.alertTimes.length >= 10)
    )
      return;
    // All occurrences stay in .error; only SMTP notifications are deduplicated.
    for (const [key, time] of this.lastAlerts)
      if (now - time >= cooldown) this.lastAlerts.delete(key);
    this.lastAlerts.set(fingerprint, now);
    this.alertTimes.push(now);
    const send = async () => {
      try {
        await this.options.alertSender!.send(record);
      } catch (error) {
        // Do not alert about an alert: SMTP downtime must not create a recursion.
        this.fallback(
          "logger.email_failed",
          "Envoi de l'alerte email impossible ; consultez .error.",
          error,
          true,
        );
      }
    };
    if (fatal) {
      // A fatal alert must not wait behind earlier alerts when the process is exiting.
      const urgent = Promise.resolve().then(send);
      this.urgentAlerts.add(urgent);
      void urgent.then(() => this.urgentAlerts.delete(urgent));
    } else this.alerts = this.alerts.then(send);
  }
  async flush(timeoutMs = 15000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          await Promise.all([this.alerts, ...this.urgentAlerts]);
          // An SMTP failure may append an additional local error while being awaited.
          await this.fileWrites;
          return true;
        })(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export let logger = new Logger({ service: "application" });

export function configureLogger(config: LoggingConfig, service: "backend" | "consumers") {
  const recipient = z.email().safeParse((config.ERROR_EMAIL_TO || config.SMTP_USER)?.trim());
  logger = new Logger({
    service,
    level: config.LOG_LEVEL,
    format: config.LOG_FORMAT ?? (config.NODE_ENV === "production" ? "json" : "pretty"),
    errorFile: resolve(projectRoot, config.LOG_ERROR_FILE),
    secrets: [config.SESSION_SECRET, config.JOURNAL_ENCRYPTION_KEY, config.SMTP_PASSWORD].filter(
      (value): value is string => Boolean(value),
    ),
    ...(config.ERROR_EMAIL_ENABLED && config.NODE_ENV !== "test" && recipient.success
      ? { alertSender: new SmtpErrorAlertSender(config, recipient.data) }
      : {}),
    cooldownMs: config.ERROR_EMAIL_COOLDOWN_MS,
  });
  if (config.ERROR_EMAIL_ENABLED && config.NODE_ENV !== "test" && !recipient.success)
    logger.info(
      "logger.email_unconfigured",
      "Alertes email indisponibles : renseignez ERROR_EMAIL_TO ou un SMTP_USER au format email.",
    );
  return logger;
}

export function bootstrapLogger(service: "backend" | "consumers") {
  // Even a malformed logging/SMTP configuration must leave a local fatal record.
  logger = new Logger({ service, errorFile: resolve(projectRoot, ".error") });
  configureLogger(readLoggingConfig(), service);
}

export function withLogContext<T>(context: LogContext, action: () => T): T {
  return scopes.run({ ...scopes.getStore(), ...context }, action);
}

export const requestLogging: RequestHandler = (req, res, next) => {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);
  const start = Date.now();
  // Record the route template rather than URLs, query strings, headers or submitted fields.
  res.once("finish", () => {
    logger.debug("http.completed", "Requête HTTP terminée.", {
      requestId,
      method: req.method,
      route: typeof req.route?.path === "string" ? req.route.path : "unmatched",
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  withLogContext({ requestId, method: req.method }, next);
};
