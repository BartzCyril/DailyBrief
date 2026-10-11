import nodemailer from "nodemailer";
import type { LoggingConfig } from "./config";

export function createSmtpTransport(config: LoggingConfig, alert = false) {
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    connectionTimeout: alert ? 5000 : 15000,
    greetingTimeout: alert ? 5000 : 15000,
    socketTimeout: alert ? 10000 : 30000,
    ...(config.SMTP_USER && config.SMTP_PASSWORD
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
      : {}),
  });
}
