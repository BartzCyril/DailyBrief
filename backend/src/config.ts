import { z } from "zod";

const boolean = z.enum(["true", "false"]).transform((value) => value === "true");
const envSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default("redis://127.0.0.1:6379"),
  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_NAME: z.string().default("dailybrief.sid"),
  SESSION_MAX_AGE: z.coerce.number().int().positive().default(604800000),
  FRONTEND_ORIGIN: z.url().default("http://localhost:5173"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  OLLAMA_BASE_URL: z.url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("qwen3:4b"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(100).default(16000),
  AI_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  AI_LANGUAGE: z.string().default("français"),
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: boolean.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.email().default("dailybrief@example.com"),
});
export type Config = z.infer<typeof envSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
