import { z } from "zod";

const boolean = z.enum(["true", "false"]).transform((value) => value === "true");
const loggingSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "error"]).default("info"),
  LOG_FORMAT: z.enum(["pretty", "json"]).optional(),
  LOG_ERROR_FILE: z.string().min(1).default(".error"),
  ERROR_EMAIL_ENABLED: boolean.default(true),
  ERROR_EMAIL_TO: z.union([z.email(), z.literal("")]).optional(),
  ERROR_EMAIL_COOLDOWN_MS: z.coerce.number().int().min(1000).default(300000),
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: boolean.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.email().default("dailybrief@example.com"),
});
export type LoggingConfig = z.infer<typeof loggingSchema> & {
  SESSION_SECRET?: string;
  JOURNAL_ENCRYPTION_KEY?: string;
};
// This can be read before validating database settings, so startup failures are logged too.
export function readLoggingConfig(env: NodeJS.ProcessEnv = process.env): LoggingConfig {
  return {
    ...loggingSchema.parse(env),
    SESSION_SECRET: env.SESSION_SECRET,
    JOURNAL_ENCRYPTION_KEY: env.JOURNAL_ENCRYPTION_KEY,
  };
}
const envSchema = loggingSchema.extend({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default("redis://127.0.0.1:6379"),
  SESSION_SECRET: z.string().min(32),
  JOURNAL_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  SESSION_COOKIE_NAME: z.string().default("dailybrief.sid"),
  SESSION_MAX_AGE: z.coerce.number().int().positive().default(604800000),
  FRONTEND_ORIGIN: z.url().default("http://localhost:5173"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  OLLAMA_BASE_URL: z.url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("qwen3:4b"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(1800000),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(100).default(16000),
  AI_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("dailybrief"),
  COLLECTION_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  AI_LANGUAGE: z.string().default("français"),
});
export type Config = z.infer<typeof envSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
